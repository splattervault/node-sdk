import { SplatterVault, SplatterVaultError, type PlayerTokenClaims, type ServerSession, type StoreTxnResult } from "@splattervault/server";

const sv = new SplatterVault({ apiKey: "sv_org_x" });
export async function typed(): Promise<[ServerSession, StoreTxnResult, PlayerTokenClaims]> {
  const session = await sv.sessions.create({ gameTypeConfigKey: "g", region: "NYC3" });
  const txn = await sv.store.grant("p", { lines: [{ currency: "GOLD", amount: 1 }] }, { idempotencyKey: "k" });
  const claims = await sv.verifyPlayerToken("t", { gameId: 42 });
  // @ts-expect-error an unknown store is refused by the types
  await sv.playerData.update(1, "p", { ops: [{ op: "set", store: "nope", key: "k", value: 1 }] });
  return [session, txn, claims];
}
export const isErr = (e: unknown): e is SplatterVaultError => e instanceof SplatterVaultError;
