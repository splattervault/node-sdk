import { type RetryMode } from "./core/retry.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface OperationSpec {
  method: HttpMethod;
  /** The path below the base URL, with `{name}` placeholders, exactly as the API description writes it. */
  path: string;
  retry: RetryMode;
  /** Overrides the client's `timeoutMs` default for this operation (slow operations: imports, server creation). */
  timeoutMs?: number;
  /** A POST that only reads (it never changes anything, so its outcome is never unknown). GETs are reads anyway. */
  read?: true;
}

const SLOW = 60_000;
const IMPORT = 120_000;

/**
 * Every operation of the Studio API this SDK calls with an organization API key, by its `operationId`. The contract
 * test checks this table against `openapi/studio-api.json` in both directions.
 */
export const OPERATIONS = {
  // ── Game-server sessions ───────────────────────────────────────────────────────────────────────────────────────
  "sessions.createCredit": { method: "POST", path: "/credits/sessions", retry: "never", timeoutMs: SLOW },
  "sessions.listCredit": { method: "GET", path: "/credits/sessions", retry: "safe" },
  "sessions.stopCredit": { method: "POST", path: "/credits/sessions/{sessionId}/stop", retry: "never", timeoutMs: SLOW },
  "sessions.renameCredit": { method: "PUT", path: "/credits/sessions/{sessionId}/friendly-name", retry: "never" },
  "sessions.rescheduleCredit": { method: "PUT", path: "/credits/sessions/{sessionId}/schedule", retry: "never" },
  "sessions.cancelScheduledCredit": { method: "POST", path: "/credits/sessions/{sessionId}/cancel-schedule", retry: "never" },
  "sessions.createSubscription": { method: "POST", path: "/subscriptions/sessions", retry: "never", timeoutMs: SLOW },
  "sessions.listSubscription": { method: "GET", path: "/subscriptions/sessions", retry: "safe" },
  "sessions.stopSubscription": { method: "POST", path: "/subscriptions/sessions/{sessionId}/stop", retry: "never", timeoutMs: SLOW },
  "sessions.renameSubscription": { method: "PUT", path: "/subscriptions/sessions/{sessionId}/friendly-name", retry: "never" },
  "sessions.rescheduleSubscription": { method: "PUT", path: "/subscriptions/sessions/{sessionId}/schedule", retry: "never" },
  "sessions.cancelScheduledSubscription": {
    method: "POST",
    path: "/subscriptions/sessions/{sessionId}/cancel-schedule",
    retry: "never"
  },
  "sessions.listMine": { method: "GET", path: "/game-sessions/my-sessions", retry: "safe" },
  "sessions.get": { method: "GET", path: "/game-sessions/{id}", retry: "safe" },
  "games.getConfigurableArgs": { method: "GET", path: "/game-types/{id}/configurable-args", retry: "safe" },
  "serverPools.claim": { method: "POST", path: "/server-pools/{id}/claim", retry: "never", timeoutMs: SLOW },

  // ── Billing ────────────────────────────────────────────────────────────────────────────────────────────────────
  "billing.getCredits": { method: "GET", path: "/credits", retry: "safe" },
  "billing.getCreditStats": { method: "GET", path: "/credits/stats", retry: "safe" },
  "billing.getKeyOrgCredits": { method: "GET", path: "/org/credits", retry: "safe" },
  "billing.getKeyOrgSubscriptions": { method: "GET", path: "/org/subscription", retry: "safe" },
  "billing.getOrgCredits": { method: "GET", path: "/organizations/{orgId}/credits", retry: "safe" },
  "billing.getOrgSubscription": { method: "GET", path: "/organizations/{orgId}/subscription", retry: "safe" },
  "billing.getSubscriptions": { method: "GET", path: "/subscriptions", retry: "safe" },
  "billing.getUsage": { method: "GET", path: "/subscriptions/usage", retry: "safe" },

  // ── Player sign-in (studio backend) ────────────────────────────────────────────────────────────────────────────
  "playerAuth.studio.signIn": { method: "POST", path: "/player-auth/studio", retry: "never" },
  // "running the same rows again changes nothing"; 503 import_busy: "send the same batch again".
  "playerAuth.studio.importPlayers": { method: "POST", path: "/player-auth/studio/import", retry: "safe", timeoutMs: IMPORT },
  "playerAuth.studio.erasePlayer": { method: "DELETE", path: "/player-auth/studio/players/{playerId}", retry: "never" },

  // ── Player data (studio backend) ───────────────────────────────────────────────────────────────────────────────
  // "A lookup only: nobody is created."
  "studioData.resolvePlayers": { method: "POST", path: "/studio-data/games/{gameId}/players/resolve", retry: "safe", read: true },
  "studioData.getPlayerData": { method: "GET", path: "/studio-data/games/{gameId}/players/{playerId}/data", retry: "safe" },
  "studioData.updatePlayerData": { method: "PATCH", path: "/studio-data/games/{gameId}/players/{playerId}/data", retry: "if-version" },
  // 204 "Deleted (or there was nothing)".
  "studioData.clearPlayerData": { method: "DELETE", path: "/studio-data/games/{gameId}/players/{playerId}/data", retry: "safe" },
  "studioData.getPlayersData": { method: "POST", path: "/studio-data/games/{gameId}/data/get", retry: "safe", read: true },
  "studioData.writePlayersData": { method: "POST", path: "/studio-data/games/{gameId}/data/write", retry: "if-version" },
  "studioData.getGameData": { method: "GET", path: "/studio-data/games/{gameId}/game-data", retry: "safe" },
  "studioData.updateGameData": { method: "PATCH", path: "/studio-data/games/{gameId}/game-data", retry: "if-version" },
  // "Re-sending the same rows changes nothing."
  "studioData.importData": { method: "POST", path: "/studio-data/games/{gameId}/import", retry: "safe", timeoutMs: IMPORT },
  "studioData.listErasedPlayers": { method: "GET", path: "/studio-data/erased-players", retry: "safe" },

  // ── Store (studio backend) ─────────────────────────────────────────────────────────────────────────────────────
  "store.studio.getCatalog": { method: "GET", path: "/store/studio/catalog", retry: "safe" },
  "store.studio.getPlayer": { method: "GET", path: "/store/studio/players/{player}", retry: "safe" },
  "store.studio.getPlayerHistory": { method: "GET", path: "/store/studio/players/{player}/history", retry: "safe" },
  "store.studio.grant": { method: "POST", path: "/store/studio/players/{player}/grants", retry: "idempotency-key" },
  "store.studio.consume": { method: "POST", path: "/store/studio/players/{player}/consume", retry: "idempotency-key" },
  "store.studio.purchase": { method: "POST", path: "/store/studio/players/{player}/purchases", retry: "idempotency-key" },
  "store.studio.updateItem": { method: "PATCH", path: "/store/studio/players/{player}/items/{instanceId}", retry: "idempotency-key" },
  "store.studio.reverse": { method: "POST", path: "/store/studio/players/{player}/reversals", retry: "idempotency-key" },
  "store.studio.syncMetaPurchases": { method: "POST", path: "/store/studio/players/{player}/platform-purchases/meta", retry: "never" },
  // "re-running a file changes nothing" (catalog); holdings: "the same row again is unchanged" (once per source).
  "store.studio.importCatalog": { method: "POST", path: "/store/studio/imports/catalog", retry: "safe", timeoutMs: IMPORT },
  "store.studio.importHoldings": { method: "POST", path: "/store/studio/imports/holdings", retry: "safe", timeoutMs: IMPORT }
} as const satisfies Record<string, OperationSpec>;

export type OperationId = keyof typeof OPERATIONS;

/** The public keys that sign player tokens (no credential: never sent with your API key). */
export const PLAYER_TOKEN_KEYS_PATH = "/player-auth/keys";
