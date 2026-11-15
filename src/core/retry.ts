import { type SplatterVaultError } from "./errors.js";

/**
 * When a request may be sent again by the SDK itself.
 *
 * - `"safe"`: reads, lookups and writes the API documents as safe to repeat (imports, clearing a player's data); after
 *   any transient failure (no answer, 408, 429, 500, 502, 503, 504).
 * - `"idempotency-key"`: store changes; after any transient failure, with the same `Idempotency-Key` and the same body.
 * - `"if-version"`: player-data writes, only when every op carries `ifVersion`, and only after an answer that proves
 *   nothing was applied (408, 429, 503). After no answer, a 500, 502 or 504 the outcome is unknown: the SDK does not
 *   send it again (a resend could meet the first write's own new version) and the error says `outcomeUnknown`.
 * - `"never"`: creating, stopping or claiming servers, sign-ins, erasing a player, data writes without `ifVersion`,
 *   the Meta purchase check: a repeat could act twice, so the SDK leaves it to you.
 */
export type RetryMode = "safe" | "idempotency-key" | "if-version" | "never";

export interface RetrySettings {
  /** Retries after the first attempt (0 turns retries off). */
  maxRetries: number;
  /** The wait before the first retry when the answer named none; it doubles each time. */
  baseDelayMs: number;
  /** The longest wait between retries when the answer named none. */
  maxDelayMs: number;
  /** The longest `Retry-After` the SDK waits out by itself; a longer one is thrown to you with `retryAfter` set. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY: RetrySettings = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 10_000
};

/**
 * The wait before retry number `retry` (1 for the first) when the answer named no `Retry-After`: exponential, capped,
 * with jitter that spreads it between half and all of the wait.
 */
export function backoffMs(retry: number, settings: RetrySettings, random: () => number = Math.random): number {
  const exp = settings.baseDelayMs * 2 ** Math.max(0, retry - 1);
  const capped = Math.min(exp, settings.maxDelayMs);
  return capped / 2 + (capped / 2) * random();
}

/**
 * Whether a failed attempt should be sent again, and after how long (ms). `retry` is the number this retry would be
 * (1 for the first); `transient` says whether the failure may be retried at all (default: `error.isTransient`). A
 * `Retry-After` is never shortened, and one longer than `maxRetryAfterMs` is not waited out.
 */
export function retryDelay(
  error: SplatterVaultError,
  retry: number,
  settings: RetrySettings,
  random?: () => number,
  transient: boolean = error.isTransient
): number | null {
  if (retry > settings.maxRetries || !transient) return null;
  if (error.retryAfter !== null) {
    const ms = error.retryAfter * 1000;
    return ms > settings.maxRetryAfterMs ? null : ms;
  }
  return backoffMs(retry, settings, random);
}
