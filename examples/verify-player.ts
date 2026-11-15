// A game server (Node.js) that only lets in players SplatterVault signed in: the game client sends its player token
// when it connects, and the server verifies it offline (no API call per player: the public keys are cached).
//
//   SV_GAME_ID=42 npx tsx examples/verify-player.ts <player token>
import { createPlayerTokenVerifier, PlayerTokenError, readSessionEnvironment } from "@splattervault/server";

// One verifier for the life of the server. No API key is needed to verify tokens.
const verifier = createPlayerTokenVerifier({ gameId: Number(process.env.SV_GAME_ID ?? 42) });

// On SplatterVault the wrapper tells the game process which session it serves (null on a pool server).
const env = readSessionEnvironment();
if (env.onSplatterVault) console.log(`serving session ${env.sessionId ?? "(pool)"} with code ${env.code}`);

export async function onPlayerConnect(token: string): Promise<string> {
  try {
    const claims = await verifier.verify(token);
    console.log(`player ${claims.sub} signed in with ${claims.amr[0]}; token valid until ${new Date(claims.exp * 1000).toISOString()}`);
    return claims.sub; // the player's SplatterVault id: the same in all your organization's games
  } catch (err) {
    if (err instanceof PlayerTokenError) {
      // token_expired: ask the client to refresh its token; keys_unavailable: try again shortly; token_invalid: refuse.
      console.warn(`refused a player: ${err.code} (${err.reason})`);
    }
    throw err;
  }
}

if (process.argv[2]) await onPlayerConnect(process.argv[2]);
