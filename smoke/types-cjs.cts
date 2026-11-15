import sdk = require("@splattervault/server");

const sv = new sdk.SplatterVault({ apiKey: "sv_org_x" });
export async function typed(): Promise<number> {
  const pool = await sv.serverPools.claim(12, { mode: "Ranked" });
  const page: sdk.ErasedPlayersPage = await sv.playerData.listErasedPlayers({ cursor: "c" });
  void page;
  return pool.sessionId;
}
