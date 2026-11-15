// After a match: give the winners their reward exactly once, and keep their stats in player data.
//
//   SV_API_KEY=sv_org_... npx tsx examples/rewards.ts <player id>
import { pathToFileURL } from "node:url";

import { SplatterVault, SplatterVaultError } from "@splattervault/server";

const GAME_ID = 42;

export async function rewardWinner(sv: SplatterVault, matchId: string, playerId: string): Promise<void> {
  // The Idempotency-Key comes from YOUR record of the reward, so a crash and a re-run never pay twice:
  // the same key and request again answers the first result (replayed: true).
  const result = await sv.store.grant(
    playerId,
    { lines: [{ currency: "GOLD", amount: 100 }, { sku: "trophy_s3", quantity: 1 }], reason: `Won match ${matchId}` },
    { idempotencyKey: `win:${matchId}:${playerId}` }
  );
  console.log(result.replayed ? "already rewarded" : `rewarded: GOLD is now ${result.balances.find((b) => b.currency === "GOLD")?.amount}`);
}

interface Stats {
  wins?: number;
  /** The matches already counted: lets a re-read tell whether OUR write went through. */
  matches?: string[];
}

/**
 * Adds one win to the player's stats, safe against concurrent changes (`ifVersion`) and against lost answers.
 *
 * - `version_conflict` (a plain one): someone else changed the stats since we read them: read again, add again.
 * - `outcomeUnknown` (no answer, 500/502/504, or code `outcome_unknown`): our write may have been applied. Never
 *   just add again: read again and look for our own mark (here the match id), which is in the value only if it was.
 */
export async function recordWin(sv: SplatterVault, playerId: string, matchId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data } = await sv.playerData.get(GAME_ID, playerId, { stores: ["readonly"], keys: ["stats"] });
    const entry = data.readonly?.stats;
    const stats = (entry?.value as Stats | undefined) ?? {};
    if (stats.matches?.includes(matchId)) return; // already counted (by an earlier try whose answer was lost)
    try {
      await sv.playerData.update(GAME_ID, playerId, {
        ops: [
          {
            op: "set",
            store: "readonly",
            key: "stats",
            value: { wins: (stats.wins ?? 0) + 1, matches: [...(stats.matches ?? []), matchId].slice(-50) },
            ifVersion: entry?.version ?? 0
          }
        ]
      });
      return;
    } catch (err) {
      if (err instanceof SplatterVaultError && (err.outcomeUnknown || err.code === "version_conflict")) continue; // re-read decides
      throw err;
    }
  }
  throw new Error("stats kept changing; gave up");
}

// A counter needs no read: `inc` adds atomically. It has no ifVersion, so the SDK never sends it twice, and after an
// unknown outcome (err.outcomeUnknown) you cannot tell whether it counted: use it where an off-by-one is acceptable.
export async function addXp(sv: SplatterVault, playerId: string, xp: number): Promise<number> {
  const { results } = await sv.playerData.update(GAME_ID, playerId, { ops: [{ op: "inc", store: "readonly", key: "xp", by: xp }] });
  return results[0]?.value as number;
}

/**
 * Selling an item back: two store changes (take the item, then pay for it), NOT one atomic change. Each has its own
 * fixed Idempotency-Key derived from the item, so the whole function is safe to run again after any failure: a
 * change that already happened answers its first result (replayed), one that did not happens now. If it keeps failing
 * after the item was taken, run it again later (or reverse the take with `sv.store.reverse`), never pay without the key.
 */
export async function sellBack(sv: SplatterVault, playerId: string, instanceId: string): Promise<void> {
  await sv.store.consume(playerId, { lines: [{ instanceId }], reason: "sold back" }, { idempotencyKey: `sell:${instanceId}` });
  await sv.store.grant(playerId, { lines: [{ currency: "GOLD", amount: 25 }], reason: "sold back" }, { idempotencyKey: `sell-pay:${instanceId}` });
}

// Run directly (not when imported): record a win for the player id given on the command line.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2]) {
  const sv = new SplatterVault({ apiKey: process.env.SV_API_KEY });
  await recordWin(sv, process.argv[2], "m-1001");
}
