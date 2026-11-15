import { type HttpClient, type IdempotentRequestOptions, type RequestOptions } from "../core/http.js";
import type {
  MetaPurchaseSyncAnswer,
  StoreCatalogImportRequest,
  StoreGrantRequest,
  StoreHistoryPage,
  StoreHoldings,
  StoreHoldingsImportRequest,
  StoreImportReport,
  StoreItemUpdateRequest,
  StoreReversalRequest,
  StoreStudioConsumeRequest,
  StoreStudioPurchaseRequest,
  StoreTxnResult,
  StudioMetaPurchaseSyncRequest,
  StudioStoreCatalog
} from "../types.js";

/**
 * A player, for the store: their SplatterVault id (uuid), or another system's id for them: `steam:<SteamID>`,
 * `meta:<org-scoped id>`, `studio:<your id>`, `xsolla:<Login project id>:<user id>`,
 * `playfab:<title id>:<PlayFabId>`, `supabase:<project ref>:<user id>`. The SDK URL-encodes it.
 */
export type StorePlayer = string;

/**
 * Your organization's store from your backend: virtual currencies and items, players' holdings, and server-side
 * changes (grant, consume, purchase, reverse), each applied exactly once per `Idempotency-Key`.
 *
 * Every change sends an `Idempotency-Key`: the SDK makes one per call and reuses it on its own retries; pass
 * `{ idempotencyKey }` to choose it (see {@link IdempotentRequestOptions}). A repeat answers the first result with
 * `replayed: true`.
 */
export class Store {
  /** @internal */
  constructor(private readonly http: HttpClient) {}

  /**
   * The whole catalog (archived entries too) and the store's settings. The key needs org:view_economy or
   * org:grant_economy.
   * @see GET /store/studio/catalog (`store.studio.getCatalog`)
   */
  getCatalog(options?: RequestOptions): Promise<StudioStoreCatalog> {
    return this.http.call("store.studio.getCatalog", { options });
  }

  /**
   * A player's balances and items.
   * @see GET /store/studio/players/{player} (`store.studio.getPlayer`)
   */
  getPlayer(player: StorePlayer, options?: RequestOptions): Promise<StoreHoldings> {
    return this.http.call("store.studio.getPlayer", { path: { player }, options });
  }

  /**
   * One page (50) of a player's store history, newest first; pass the answer's `next` as `before` for older ones
   * (`next` is null on the last page). See {@link Store.historyPages} to walk every page.
   * @see GET /store/studio/players/{player}/history (`store.studio.getPlayerHistory`)
   */
  getHistory(player: StorePlayer, query?: { before?: string }, options?: RequestOptions): Promise<StoreHistoryPage> {
    return this.http.call("store.studio.getPlayerHistory", { path: { player }, query: { before: query?.before }, options });
  }

  /**
   * Every page of a player's store history, newest first, from `before` (default: the newest).
   *
   * ```ts
   * for await (const page of sv.store.historyPages(playerId)) {
   *   for (const txn of page.txns) console.log(txn.kind, txn.createdAt);
   * }
   * ```
   */
  async *historyPages(player: StorePlayer, query?: { before?: string }, options?: RequestOptions): AsyncGenerator<StoreHistoryPage, void, undefined> {
    let before = query?.before;
    for (;;) {
      const page = await this.getHistory(player, { before }, options);
      yield page;
      if (!page.next) return;
      before = page.next;
    }
  }

  /**
   * Gives a player items and currency (1-50 lines: `{ sku, quantity, custom? }` or `{ currency, amount }`). Bundles
   * give their contents; currency caps and `maxOwned` apply. The key needs org:grant_economy.
   * @see POST /store/studio/players/{player}/grants (`store.studio.grant`)
   */
  grant(player: StorePlayer, body: StoreGrantRequest, options?: IdempotentRequestOptions): Promise<StoreTxnResult> {
    return this.http.call("store.studio.grant", { path: { player }, body, options });
  }

  /**
   * Uses up or takes a player's items and currency (by SKU oldest first, by `instanceId`, or `{ currency, amount }`),
   * never below zero: `insufficient_items` / `insufficient_funds` otherwise.
   * @see POST /store/studio/players/{player}/consume (`store.studio.consume`)
   */
  consume(player: StorePlayer, body: StoreStudioConsumeRequest, options?: IdempotentRequestOptions): Promise<StoreTxnResult> {
    return this.http.call("store.studio.consume", { path: { player }, body, options });
  }

  /**
   * Buys an item with the player's virtual currency, from the server (the item's player-purchase switch does not
   * apply). Send `expectedPrice` to refuse a changed price (`price_changed`).
   * @see POST /store/studio/players/{player}/purchases (`store.studio.purchase`)
   */
  purchase(player: StorePlayer, body: StoreStudioPurchaseRequest, options?: IdempotentRequestOptions): Promise<StoreTxnResult> {
    return this.http.call("store.studio.purchase", { path: { player }, body, options });
  }

  /**
   * Sets the custom data of one of a player's items (a JSON object of at most 1 KB, or null).
   * @see PATCH /store/studio/players/{player}/items/{instanceId} (`store.studio.updateItem`)
   */
  updateItem(
    player: StorePlayer,
    instanceId: string,
    body: StoreItemUpdateRequest,
    options?: IdempotentRequestOptions
  ): Promise<StoreTxnResult> {
    return this.http.call("store.studio.updateItem", { path: { player, instanceId }, body, options });
  }

  /**
   * Reverses an earlier change, named by its `txn` id or by the `originalKey` (the Idempotency-Key it was sent with):
   * takes back what the player still holds and gives back what it took; what was spent already is in `shortfall`.
   * Once per change (`already_reversed`).
   * @see POST /store/studio/players/{player}/reversals (`store.studio.reverse`)
   */
  reverse(player: StorePlayer, body: StoreReversalRequest, options?: IdempotentRequestOptions): Promise<StoreTxnResult> {
    return this.http.call("store.studio.reverse", { path: { player }, body, options });
  }

  /**
   * Checks the player's Meta Quest purchases and grants what is new (the player must have Meta linked). Not retried
   * by the SDK.
   * @see POST /store/studio/players/{player}/platform-purchases/meta (`store.studio.syncMetaPurchases`)
   */
  syncMetaPurchases(player: StorePlayer, body: StudioMetaPurchaseSyncRequest, options?: RequestOptions): Promise<MetaPurchaseSyncAnswer> {
    return this.http.call("store.studio.syncMetaPurchases", { path: { player }, body, options });
  }

  /**
   * Imports a catalog (`format`: `playfab`, `xsolla` or `sv`; 1-1,000 rows). Re-running a file changes nothing, so
   * the SDK retries this call. The key needs org:manage_economy.
   * @see POST /store/studio/imports/catalog (`store.studio.importCatalog`)
   */
  importCatalog(body: StoreCatalogImportRequest, options?: RequestOptions): Promise<StoreImportReport> {
    return this.http.call("store.studio.importCatalog", { body, options });
  }

  /**
   * Imports players' balances and items (1-1,000 rows; each player once per `source`, so the same rows again change
   * nothing and the SDK retries this call). The key needs org:manage_economy.
   * @see POST /store/studio/imports/holdings (`store.studio.importHoldings`)
   */
  importHoldings(body: StoreHoldingsImportRequest, options?: RequestOptions): Promise<StoreImportReport> {
    return this.http.call("store.studio.importHoldings", { body, options });
  }
}
