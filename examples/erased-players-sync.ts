// For studios that keep player data in their own database too: every few minutes, delete what you hold for players
// that were erased (by themselves in a game, by you, or by SplatterVault support).
//
//   SV_API_KEY=sv_org_... npx tsx examples/erased-players-sync.ts
import { SplatterVault } from "@splattervault/server";

const sv = new SplatterVault({ apiKey: process.env.SV_API_KEY });

// Keep the cursor in your database; here, in memory. The first run starts from a date.
let cursor: string | undefined;

async function deleteFromMyDatabase(playerIds: string[]): Promise<void> {
  if (playerIds.length) console.log(`deleting ${playerIds.length} erased players`);
}

export async function syncErasedPlayers(): Promise<void> {
  const start = cursor ? { cursor } : { since: new Date(Date.now() - 30 * 24 * 3600 * 1000) };
  for await (const page of sv.playerData.erasedPlayerPages(start)) {
    await deleteFromMyDatabase(page.players.map((p) => p.id));
    cursor = page.next; // always set: save it only after the page is handled
  }
}

await syncErasedPlayers();
setInterval(() => void syncErasedPlayers().catch((err: unknown) => console.error(err)), 5 * 60 * 1000).unref();
