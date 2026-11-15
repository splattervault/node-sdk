/**
 * `@splattervault/server`: the SplatterVault SDK for your game backend and game servers (Node.js 18+).
 *
 * It calls the Studio API with your organization API key, which belongs on servers only. Game clients use a
 * game-client SDK (Unity today) and player tokens.
 *
 * @packageDocumentation
 */
export { SplatterVault, isBrowserLike, type SplatterVaultOptions } from "./client.js";
export {
  SplatterVaultError,
  SDK_ERROR_CODES,
  TRANSIENT_STATUSES,
  NOT_APPLIED_STATUSES,
  OUTCOME_UNKNOWN_STATUSES,
  type SdkErrorCode
} from "./core/errors.js";
export {
  IDEMPOTENCY_KEY_RE,
  MAX_RETRIES,
  newIdempotencyKey,
  type FetchLike,
  type IdempotentRequestOptions,
  type RequestOptions
} from "./core/http.js";
export { DEFAULT_RETRY, type RetryMode, type RetrySettings } from "./core/retry.js";
export { OPERATIONS, type OperationId, type OperationSpec } from "./operations.js";
export {
  PlayerTokenVerifier,
  PlayerTokenError,
  createPlayerTokenVerifier,
  verifyPlayerToken,
  DEFAULT_BASE_URL,
  DEFAULT_STALE_IF_ERROR_SECONDS,
  PLAYER_TOKEN_AUDIENCE_PREFIX,
  PLAYER_TOKEN_CLOCK_SKEW_SECONDS,
  PLAYER_TOKEN_ISSUER,
  PLAYER_TOKEN_MAX_LIFETIME_SECONDS,
  type PlayerSignInMethod,
  type PlayerTokenClaims,
  type PlayerTokenErrorCode,
  type PlayerTokenFailure,
  type PlayerTokenVerifierOptions,
  type VerifyOptions
} from "./playerToken/verify.js";
export { type PlayerTokenJwk, type PlayerTokenJwks } from "./playerToken/jwks.js";
export { readSessionEnvironment, type SessionEnvironment } from "./sessionEnv.js";
export { Billing } from "./resources/billing.js";
export { PlayerData, type DataReadQuery, type ErasedPlayersQuery, type GameId } from "./resources/playerData.js";
export { Players } from "./resources/players.js";
export {
  Games,
  ServerPools,
  Sessions,
  SessionWaitError,
  SubscriptionSessions,
  type ReadySession,
  type SessionId,
  type SessionWaitErrorCode,
  type WaitUntilReadyOptions
} from "./resources/sessions.js";
export { Store, type StorePlayer } from "./resources/store.js";
export { SDK_VERSION } from "./version.js";
export type * from "./types.js";
