/**
 * Codes the SDK itself sets on a {@link SplatterVaultError}. With `status` 0 (no HTTP answer): `network_error`,
 * `timeout`, `aborted`. With the answer's status: `invalid_response`, `redirect_not_followed`, `outcome_unknown`.
 */
export const SDK_ERROR_CODES = {
  /** No answer: no connection, a reset, a DNS or TLS failure. The request may or may not have arrived. */
  networkError: "network_error",
  /** No answer within `timeoutMs`. The request may or may not have arrived. */
  timeout: "timeout",
  /** Your `signal` aborted the call. */
  aborted: "aborted",
  /** The answer was not the JSON the SDK expected (the HTTP status is kept). */
  invalidResponse: "invalid_response",
  /**
   * The API answered a redirect (3xx). The SDK never follows one, so your API key never travels to another address;
   * `details.location` says where it pointed. Check `baseUrl` (it must be the https URL the API is served at).
   */
  redirectNotFollowed: "redirect_not_followed",
  /**
   * A player-data write with `ifVersion` was sent again after an answer that proved it was not applied, and the second
   * send met `version_conflict`: the first may have been applied after all (`outcomeUnknown` is true). Re-read.
   */
  outcomeUnknown: "outcome_unknown"
} as const;

/** One of the codes the SDK sets itself; see {@link SDK_ERROR_CODES}. */
export type SdkErrorCode = (typeof SDK_ERROR_CODES)[keyof typeof SDK_ERROR_CODES];

/** HTTP statuses the SDK treats as "try again later" (with network errors and timeouts): 408, 429, 500, 502, 503, 504. */
export const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/** Transient answers that prove the request was not applied (refused before it ran): 408, 429, 503. */
export const NOT_APPLIED_STATUSES: ReadonlySet<number> = new Set([408, 429, 503]);

/** Answers after which a write may or may not have been applied (with no answer at all): 500, 502, 504. */
export const OUTCOME_UNKNOWN_STATUSES: ReadonlySet<number> = new Set([500, 502, 504]);

export interface SplatterVaultErrorInit {
  status: number;
  code: string | null;
  message: string;
  operationId: string;
  method: string;
  path: string;
  details?: unknown;
  retryAfter?: number | null;
  requestId?: string | null;
  errorName?: string | null;
  errors?: unknown[] | null;
  body?: unknown;
  attempts?: number;
  outcomeUnknown?: boolean;
  idempotencyKey?: string | null;
  cause?: unknown;
}

/**
 * A refusal from the SplatterVault API, or a call that got no answer.
 *
 * Act on {@link SplatterVaultError.code | code} (the API's stable `error` code such as `insufficient_funds`,
 * `version_conflict` or `rate_limited`), never on `message`: the message is a sentence for people and may change.
 * The set of codes is open: handle an unknown code by its HTTP {@link SplatterVaultError.status | status}.
 *
 * Two answer shapes are read:
 * - the studio routes' `{ "error", "message", "details"? }` (player sign-in, player data, the store);
 * - the game-server session and billing routes' `{ "name", "message", "status", "errors" }`, which has no code:
 *   `code` is null and {@link SplatterVaultError.errorName | errorName} holds `name` (such as `BAD_REQUEST`).
 *   Their platform-ban answer `{ "banned": true, ... }` is read as code `banned`.
 *
 * `status` 0 means no HTTP answer: the code is then `network_error`, `timeout` or `aborted`.
 *
 * When a write failed without a clear answer, {@link SplatterVaultError.outcomeUnknown | outcomeUnknown} is true: it
 * may or may not have been applied. Store changes: send it again with the same
 * {@link SplatterVaultError.idempotencyKey | idempotencyKey} (and the same body), never without it. Player-data writes:
 * read the key again; if its version moved and the value is the one you wrote, your write was applied.
 */
export class SplatterVaultError extends Error {
  override readonly name = "SplatterVaultError";
  /** The HTTP status; 0 when no answer arrived (network error, timeout, abort). */
  readonly status: number;
  /** The API's `error` code, an SDK code ({@link SDK_ERROR_CODES}), or null when the answer had none. */
  readonly code: string | null;
  /** The answer's `details` (e.g. the current versions of a `version_conflict`), or undefined. */
  readonly details: unknown;
  /** The answer's `Retry-After`, in seconds: do not send this request again sooner. Null when absent. */
  readonly retryAfter: number | null;
  /** The answer's `x-request-id` (quote it when you contact SplatterVault support). Null when absent. */
  readonly requestId: string | null;
  /** The session and billing routes' `name` (e.g. `NOT_FOUND`), or null. */
  readonly errorName: string | null;
  /** The session and billing routes' validation `errors`, or null. */
  readonly errors: unknown[] | null;
  /** The parsed answer body, as received (never holds your API key). */
  readonly body: unknown;
  /** The API operation that failed, e.g. `store.studio.grant`. */
  readonly operationId: string;
  /** The HTTP method of the failed request. */
  readonly method: string;
  /** The request path (below the base URL, without the query). */
  readonly path: string;
  /** How many times the request was sent, retries included (0 when it never left). */
  readonly attempts: number;
  /**
   * True when this write may or may not have been applied: no answer, a 500, 502 or 504 (on any attempt), an abort
   * while a send was under way, or a resent player-data write that met `version_conflict` (code `outcome_unknown`).
   * Always false for reads.
   */
  readonly outcomeUnknown: boolean;
  /**
   * The `Idempotency-Key` the store change was sent with (yours or the one the SDK made), or null for other
   * operations. To resolve an unknown outcome, send the same change again with `{ idempotencyKey: err.idempotencyKey }`.
   */
  readonly idempotencyKey: string | null;

  constructor(init: SplatterVaultErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.retryAfter = init.retryAfter ?? null;
    this.requestId = init.requestId ?? null;
    this.errorName = init.errorName ?? null;
    this.errors = init.errors ?? null;
    this.body = init.body;
    this.operationId = init.operationId;
    this.method = init.method;
    this.path = init.path;
    this.attempts = init.attempts ?? 0;
    this.outcomeUnknown = init.outcomeUnknown ?? false;
    this.idempotencyKey = init.idempotencyKey ?? null;
  }

  /** True when {@link SplatterVaultError.code | code} is `code`. */
  is(code: string): boolean {
    return this.code === code;
  }

  /** No answer arrived (a network error or a timeout): the request may or may not have been applied. */
  get isNetworkError(): boolean {
    return this.status === 0 && (this.code === SDK_ERROR_CODES.networkError || this.code === SDK_ERROR_CODES.timeout);
  }

  /**
   * The same request may succeed later: no answer arrived, or the API answered 408, 429, 500, 502, 503 or 504. Whether
   * the SDK sent it again by itself depends on the operation (see the README's retry rules).
   */
  get isTransient(): boolean {
    return this.isNetworkError || TRANSIENT_STATUSES.has(this.status);
  }

  /** @internal The same error with other fields (the SDK's final touches: attempts, outcome, key). */
  with(changes: Partial<SplatterVaultErrorInit>): SplatterVaultError {
    return new SplatterVaultError({
      status: this.status,
      code: this.code,
      message: this.message,
      operationId: this.operationId,
      method: this.method,
      path: this.path,
      details: this.details,
      retryAfter: this.retryAfter,
      requestId: this.requestId,
      errorName: this.errorName,
      errors: this.errors,
      body: this.body,
      attempts: this.attempts,
      outcomeUnknown: this.outcomeUnknown,
      idempotencyKey: this.idempotencyKey,
      cause: this.cause,
      ...changes
    });
  }
}

/** Reads `Retry-After` (whole seconds or an HTTP date) as seconds to wait; null when absent or unreadable. */
export function parseRetryAfter(header: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (header == null) return null;
  const text = header.trim();
  if (text === "") return null;
  if (/^\d+$/.test(text)) return Math.min(Number(text), 86_400);
  // An HTTP date ("Sun, 15 Nov 2026 01:00:03 GMT"): it names a weekday or month; "-1" or "1.5" is no date.
  if (!/[a-z]{3}/i.test(text)) return null;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, (at - nowMs) / 1000);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What an error answer's body says, in either shape (see {@link SplatterVaultError}). */
export function readErrorBody(body: unknown): {
  code: string | null;
  message: string | null;
  details: unknown;
  errorName: string | null;
  errors: unknown[] | null;
} {
  const out = { code: null as string | null, message: null as string | null, details: undefined as unknown, errorName: null as string | null, errors: null as unknown[] | null };
  if (!isRecord(body)) return out;
  if (typeof body.error === "string") out.code = body.error;
  if (typeof body.message === "string") out.message = body.message;
  if (body.details !== undefined && body.details !== null) out.details = body.details;
  if (out.code === null) {
    if (body.banned === true) {
      // The session and billing routes' platform ban: { banned, type, scopes, reason }.
      out.code = "banned";
      if (typeof body.reason === "string") out.message = body.reason;
      out.details = { type: body.type, scopes: body.scopes };
    } else {
      if (typeof body.name === "string") out.errorName = body.name;
      if (Array.isArray(body.errors)) out.errors = body.errors;
    }
  }
  return out;
}
