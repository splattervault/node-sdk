// Your own accounts, SplatterVault player tokens: your backend signs a player in with YOUR id for them and hands the
// token to their game client, which then calls the player routes (store, player data) as that player.
//
//   SV_API_KEY=sv_org_... npx tsx examples/studio-sign-in.ts
import { SplatterVault } from "@splattervault/server";

const sv = new SplatterVault({ apiKey: process.env.SV_API_KEY });

export async function tokenForMyUser(userId: string, displayName: string) {
  const { token, expiresAt, player } = await sv.players.signIn({ gameId: 42, externalId: `user-${userId}`, displayName });
  if (player.newPlayer) console.log(`first sign-in of ${userId}: SplatterVault player ${player.id}`);
  return { token, expiresAt }; // send to the game client; it lasts about an hour
}

// When one of your users deletes their account: erase the player and everything SplatterVault keeps about them.
export async function deleteMyUser(playerId: string): Promise<void> {
  await sv.players.erase(playerId);
}
