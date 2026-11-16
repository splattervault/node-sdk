// A matchmaker's backend: when a match forms, get it a dedicated server and hand the players its address.
// Claims a warm server from a pool when you have one (seconds), else starts a new session (about a minute).
//
//   SV_API_KEY=sv_org_... SV_POOL_ID=12 npx tsx examples/match-server.ts
import { poolClaimConflict, SplatterVault, type SessionConnection } from "@splattervault/server";

const sv = new SplatterVault({ apiKey: process.env.SV_API_KEY, userAgent: "example-matchmaker/1.0" });
const poolId = process.env.SV_POOL_ID ? Number(process.env.SV_POOL_ID) : undefined;

async function serverForMatch(matchId: string): Promise<{ sessionId: number; connection: SessionConnection }> {
  if (poolId !== undefined) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const claim = await sv.serverPools.claim(poolId, { friendlyName: `Match ${matchId}`, mode: "Ranked" });
        // primaryPort is the port players join on. A game launched with the room port ({{slavePort}}) has none in
        // the claim answer (the server starts the room after the claim): wait for the session and read it.
        if (claim.connection?.primaryPort != null) return { sessionId: claim.sessionId, connection: claim.connection };
        return { sessionId: claim.sessionId, connection: await waitForConnection(claim.sessionId) };
      } catch (err) {
        // A 409 claimed nothing. "busy" (another claim was running, or the idle server could not take the session):
        // one more try shortly. "no_warm_server": fall back to a new session. null: a real failure (403: the key
        // lacks org:manage_pools; 404: no such pool; 400: the pool is paused, or credits).
        const conflict = poolClaimConflict(err);
        if (conflict === null) throw err;
        if (conflict === "busy" && attempt === 1) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        break;
      }
    }
  }
  const session = await sv.sessions.create({
    gameTypeConfigKey: "my-game",
    region: "NYC3",
    friendlyName: `Match ${matchId}`,
    idleTimeoutMinutes: 15, // stops by itself 15 minutes after the last player leaves
    autoDestroyOnProcessExit: true
  });
  return { sessionId: session.id, connection: await waitForConnection(session.id) };
}

async function waitForConnection(sessionId: number): Promise<SessionConnection> {
  // Polls until the game says it is ready (or rejects: SessionWaitError session_ended / wait_timeout).
  const session = await sv.sessions.waitUntilReady(sessionId, { timeoutMs: 180_000 });
  if (!session.connection) throw new Error(`session ${sessionId} is ready but has no connection details`);
  // Players join on connection.host and connection.primaryPort, not slaveIp and slavePort (slavePort is the room
  // port the server gave the session, which only games launched with {{slavePort}} or {{port}} listen on).
  return session.connection;
}

const { sessionId, connection } = await serverForMatch("m-1001");
console.log(`match m-1001 → session ${sessionId} at ${connection.host}:${connection.primaryPort}`);

// When the match is over (if the server does not stop by itself):
const { totalCost } = await sv.sessions.stop(sessionId);
console.log(`stopped; it cost ${totalCost} credits`);
