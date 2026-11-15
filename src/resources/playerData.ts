import { type HttpClient, type RequestOptions } from "../core/http.js";
import type {
  DataImportReport,
  DataImportRequest,
  DataOp,
  DataOpResults,
  ErasedPlayersPage,
  GameDataOp,
  GameDataStore,
  PlayerDataStore,
  PlayerRef,
  PlayersDataAnswer,
  PlayersDataRequest,
  PlayersWriteAnswer,
  PlayersWriteRequest,
  ResolvePlayersAnswer,
  StudioGameDataAnswer,
  StudioPlayerDataAnswer
} from "../types.js";

/** A game id: one of your organization's games. */
export type GameId = number | string;

/** What to read of a player's or a game's data. */
export interface DataReadQuery<Store extends string> {
  /** Which stores (default: all). */
  stores?: readonly Store[];
  /** Which keys, at most 100 (default: every key). */
  keys?: readonly string[];
  /** true: versions and times without the values. */
  keysOnly?: boolean;
}

/** Where to start reading erased players. */
export interface ErasedPlayersQuery {
  /** The `next` of the previous page (store it after each page). Takes precedence over `since`. */
  cursor?: string;
  /** For the very first call only: erases after this time (ISO 8601 or a Date). */
  since?: string | Date;
}

const conditional = (ops: readonly { ifVersion?: number | null }[]): boolean =>
  ops.length > 0 && ops.every((op) => typeof op.ifVersion === "number");

/** An empty list would read EVERYTHING (the API reads every store and key when none is named): refused. */
function nonEmpty(list: readonly unknown[] | undefined, name: string): void {
  if (list !== undefined && list.length === 0) {
    throw new TypeError(`${name} must not be empty: leave it out to read every one, or name at least one`);
  }
}

const readQuery = (q: DataReadQuery<string> | undefined) => {
  if (q === undefined) return undefined;
  nonEmpty(q.stores, "stores");
  nonEmpty(q.keys, "keys");
  return { stores: q.stores, keys: q.keys, keysOnly: q.keysOnly === undefined ? undefined : String(q.keysOnly) };
};

/**
 * Player data from your backend: each player's stores (`player`, `readonly`, `internal`) and the game's own data
 * (`public`, `internal`), with versions for safe concurrent changes (`ifVersion`).
 *
 * Writes are all or nothing. The SDK sends a write again only when every op carries `ifVersion`, and only after an
 * answer that proves nothing was applied (408, 429, 503). After no answer, a timeout, a 500, 502 or 504, the write
 * may or may not have been applied: the error has `outcomeUnknown: true` and is not sent again (a second send could
 * meet the first one's own new version). Then read the key again: if its version moved and the value is the one you
 * wrote, your write was applied; do not simply apply your change again on top of it.
 */
export class PlayerData {
  /** @internal */
  constructor(private readonly http: HttpClient) {}

  /**
   * SplatterVault player ids for the ids other systems know your players by (at most 100 refs:
   * `{ provider, providerId, providerApp? }` or an SV player id). `id` is null for refs nobody holds. A lookup only.
   * @see POST /studio-data/games/{gameId}/players/resolve (`studioData.resolvePlayers`)
   */
  resolve(gameId: GameId, body: { refs: ReadonlyArray<PlayerRef | string> }, options?: RequestOptions): Promise<ResolvePlayersAnswer> {
    return this.http.call("studioData.resolvePlayers", { path: { gameId }, body, options });
  }

  /**
   * One player's data in a game, by store and key: `{ data: { player: { <key>: { value, version, ... } }, ... } }`.
   * @see GET /studio-data/games/{gameId}/players/{playerId}/data (`studioData.getPlayerData`)
   */
  async get(gameId: GameId, playerId: string, query?: DataReadQuery<PlayerDataStore>, options?: RequestOptions): Promise<StudioPlayerDataAnswer> {
    return this.http.call("studioData.getPlayerData", { path: { gameId, playerId }, query: readQuery(query), options });
  }

  /**
   * Changes one player's data (at most 100 ops: `set`, `delete`, `inc`), all or nothing. A failed `ifVersion` is
   * `version_conflict` with the current versions in `details`. On `outcomeUnknown` (see {@link PlayerData}), read
   * before writing again; a resent write that meets `version_conflict` is reported as code `outcome_unknown`.
   * @see PATCH /studio-data/games/{gameId}/players/{playerId}/data (`studioData.updatePlayerData`)
   */
  update(gameId: GameId, playerId: string, body: { ops: readonly DataOp[] }, options?: RequestOptions): Promise<DataOpResults> {
    return this.http.call("studioData.updatePlayerData", {
      path: { gameId, playerId },
      body,
      options,
      conditional: conditional(body.ops)
    });
  }

  /**
   * Deletes all of one player's data in a game (the player stays). Resolves when done, also when there was nothing.
   * @see DELETE /studio-data/games/{gameId}/players/{playerId}/data (`studioData.clearPlayerData`)
   */
  clear(gameId: GameId, playerId: string, options?: RequestOptions): Promise<void> {
    return this.http.call("studioData.clearPlayerData", { path: { gameId, playerId }, options });
  }

  /**
   * Several players' data (at most 100 players and 50 keys); `notFound` lists ids of no live player.
   * @see POST /studio-data/games/{gameId}/data/get (`studioData.getPlayersData`)
   */
  async getMany(gameId: GameId, body: PlayersDataRequest, options?: RequestOptions): Promise<PlayersDataAnswer> {
    nonEmpty(body.stores, "stores");
    nonEmpty(body.keys, "keys");
    return this.http.call("studioData.getPlayersData", { path: { gameId }, body, options });
  }

  /**
   * Changes several players' data atomically (at most 100 players, 1,000 ops in all): all or nothing across every
   * player. Sent again by the SDK only as {@link PlayerData} says (every op with `ifVersion`, after 408/429/503).
   * @see POST /studio-data/games/{gameId}/data/write (`studioData.writePlayersData`)
   */
  writeMany(gameId: GameId, body: PlayersWriteRequest, options?: RequestOptions): Promise<PlayersWriteAnswer> {
    return this.http.call("studioData.writePlayersData", {
      path: { gameId },
      body,
      options,
      conditional: body.writes.length > 0 && body.writes.every((w) => conditional(w.ops))
    });
  }

  /**
   * The game's own data (`public`: players can read it; `internal`: only your backend).
   * @see GET /studio-data/games/{gameId}/game-data (`studioData.getGameData`)
   */
  async getGameData(gameId: GameId, query?: DataReadQuery<GameDataStore>, options?: RequestOptions): Promise<StudioGameDataAnswer> {
    return this.http.call("studioData.getGameData", { path: { gameId }, query: readQuery(query), options });
  }

  /**
   * Changes the game's data (`set` and `delete`, at most 100 ops, values at most 256 KiB). Players read `public`
   * within 30 seconds. Sent again by the SDK only as {@link PlayerData} says.
   * @see PATCH /studio-data/games/{gameId}/game-data (`studioData.updateGameData`)
   */
  updateGameData(gameId: GameId, body: { ops: readonly GameDataOp[] }, options?: RequestOptions): Promise<DataOpResults> {
    return this.http.call("studioData.updateGameData", { path: { gameId }, body, options, conditional: conditional(body.ops) });
  }

  /**
   * Imports player and game data (at most 1,000 rows, 8 MiB). `dryRun: true` writes nothing; the same rows again
   * change nothing, so the SDK retries this call.
   * @see POST /studio-data/games/{gameId}/import (`studioData.importData`)
   */
  import(gameId: GameId, body: DataImportRequest, options?: RequestOptions): Promise<DataImportReport> {
    return this.http.call("studioData.importData", { path: { gameId }, body, options });
  }

  /**
   * One page (oldest first, 500 at most) of your organization's erased players, for deleting what you keep about
   * them. Store the answer's `next` and pass it back as `cursor`; `more: true` means call again now.
   * @see GET /studio-data/erased-players (`studioData.listErasedPlayers`)
   */
  listErasedPlayers(query?: ErasedPlayersQuery, options?: RequestOptions): Promise<ErasedPlayersPage> {
    const cursor = query?.cursor;
    const since = cursor === undefined ? query?.since : undefined;
    return this.http.call("studioData.listErasedPlayers", {
      query: { cursor, since: since instanceof Date ? since.toISOString() : since },
      options
    });
  }

  /**
   * Every page of erased players from `cursor` (or `since`), until a page says `more: false`. Save each page's `next`
   * once you have handled it, and start there next time (poll every few minutes).
   *
   * ```ts
   * for await (const page of sv.playerData.erasedPlayerPages({ cursor: saved })) {
   *   await deleteMyRows(page.players.map((p) => p.id));
   *   saved = page.next;
   * }
   * ```
   */
  async *erasedPlayerPages(query?: ErasedPlayersQuery, options?: RequestOptions): AsyncGenerator<ErasedPlayersPage, void, undefined> {
    let next: ErasedPlayersQuery = { ...query };
    for (;;) {
      const page = await this.listErasedPlayers(next, options);
      yield page;
      if (!page.more) return;
      next = { cursor: page.next };
    }
  }
}
