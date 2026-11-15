import { type HttpClient, type RequestOptions } from "../core/http.js";
import type { PlayerImportReport, PlayerImportRequest, PlayerSignIn, StudioSignInRequest } from "../types.js";

/** Studio player sign-in from your backend: sign players in with your own ids, import players, erase players. */
export class Players {
  /** @internal */
  constructor(private readonly http: HttpClient) {}

  /**
   * Signs a player in with your own id for them (`externalId`, 1-128 visible ASCII characters) and answers a player
   * token (about an hour) to hand to that player's game client. The same `externalId` is always the same player.
   * The key needs org:issue_player_tokens; the game's "studio" sign-in must be on. Not retried by the SDK.
   * @see POST /player-auth/studio (`playerAuth.studio.signIn`)
   */
  signIn(body: StudioSignInRequest, options?: RequestOptions): Promise<PlayerSignIn> {
    return this.http.call("playerAuth.studio.signIn", { body, options });
  }

  /**
   * Imports players from other systems (at most 1,000 rows, 1 MB): their identities, emails, bcrypt password hashes
   * and names. `dryRun: true` writes nothing; the same rows again change nothing, so the SDK retries this call. The
   * key needs org:import_players.
   * @see POST /player-auth/studio/import (`playerAuth.studio.importPlayers`)
   */
  import(body: PlayerImportRequest, options?: RequestOptions): Promise<PlayerImportReport> {
    return this.http.call("playerAuth.studio.importPlayers", { body, options });
  }

  /**
   * Erases a player and everything every studio service keeps about them (identities, data in every game, store
   * holdings). It cannot be undone; their tokens stop working. Resolves when erased (204). Not retried by the SDK.
   * The key needs org:issue_player_tokens.
   * @see DELETE /player-auth/studio/players/{playerId} (`playerAuth.studio.erasePlayer`)
   */
  erase(playerId: string, options?: RequestOptions): Promise<void> {
    return this.http.call("playerAuth.studio.erasePlayer", { path: { playerId }, options });
  }
}
