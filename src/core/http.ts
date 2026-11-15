import { randomUUID } from "node:crypto";

import { OPERATIONS, type OperationId } from "../operations.js";
import {
  NOT_APPLIED_STATUSES,
  OUTCOME_UNKNOWN_STATUSES,
  parseRetryAfter,
  readErrorBody,
  SDK_ERROR_CODES,
  SplatterVaultError
} from "./errors.js";
import { retryDelay, type RetrySettings } from "./retry.js";
import { intInRange, MAX_TIMER_MS } from "./validate.js";

/** The most retries a client or a call may ask for. */
export const MAX_RETRIES = 20;

/** The `fetch` the SDK calls: the global one by default, or any function with its signature. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Options every call accepts as its last argument. */
export interface RequestOptions {
  /** Aborts the call (and any wait between retries). The call then rejects with code `aborted`. */
  signal?: AbortSignal;
  /** How long one attempt may take in ms, answer body included: 1 to 2147483647 (default: the client's `timeoutMs`). */
  timeoutMs?: number;
  /**
   * Retries after the first attempt for this call, 0 to 20 (default: the client's `maxRetries`). Only operations that
   * are safe to repeat are ever retried; this cannot make another operation retry.
   */
  maxRetries?: number;
  /**
   * Extra request headers. They never replace `X-API-Key`, `Idempotency-Key`, `Content-Type` or `Accept`. The SDK
   * sends no `If-None-Match` itself (no server operation declares ETags); if you send one, it adds
   * `Cache-Control: max-age=0` (Node's fetch would otherwise add `no-cache`, and no 304 would come), and a 304 answer
   * rejects with a {@link SplatterVaultError} of `status` 304.
   */
  headers?: Record<string, string>;
}

/** Options of a store change (grant, consume, purchase, item update, reversal). */
export interface IdempotentRequestOptions extends RequestOptions {
  /**
   * The change's `Idempotency-Key` (1-128 visible ASCII characters). By default the SDK makes one per call
   * (`crypto.randomUUID()`) and sends it with every retry of that call; a failed call's error carries it
   * (`err.idempotencyKey`). Pass your own, derived from your own record (e.g. `reward:${matchId}:${playerId}`), to
   * stay exactly-once across process restarts and your own retries: the same key and request again answers the first
   * result with `replayed: true`. Never send the same change again WITHOUT its key after an unknown outcome.
   * `null` (or leaving it out) makes a new one, so `{ idempotencyKey: err.idempotencyKey }` works for any error.
   */
  idempotencyKey?: string | null;
}

export interface HttpConfig {
  apiKey: string;
  baseUrl: string;
  fetch: FetchLike;
  timeoutMs: number;
  retry: RetrySettings;
  userAgent: string;
}

type Scalar = string | number | boolean;
export type QueryValue = Scalar | readonly Scalar[] | null | undefined;

export interface CallInput {
  path?: Record<string, string | number | undefined | null>;
  query?: Record<string, QueryValue>;
  body?: unknown;
  options?: IdempotentRequestOptions | undefined;
  /** For `"if-version"` operations: true when every op carries `ifVersion` (the call may then be retried). */
  conditional?: boolean;
}

/** The header an `Idempotency-Key` must match: 1-128 visible ASCII characters. */
export const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,128}$/;

/** A new `Idempotency-Key` (a random uuid). */
export function newIdempotencyKey(): string {
  return randomUUID();
}

const MANAGED_HEADERS = new Set(["x-api-key", "idempotency-key", "content-type", "accept"]);

/**
 * Fills `{name}` placeholders, each value URL-encoded. Throws a TypeError for a missing one, and for `.` or `..`
 * (URL-encoding leaves dots alone, and a dot segment would turn the request into another route).
 */
export function fillPath(template: string, params: CallInput["path"] = {}): string {
  return template.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const value = params[name];
    if (value === undefined || value === null || value === "") throw new TypeError(`${name} is required`);
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`);
    const text = String(value);
    if (text === "." || text === "..") throw new TypeError(`${name} must not be "${text}"`);
    return encodeURIComponent(text);
  });
}

/** The query string (with `?`) of the defined values: arrays comma-separated, booleans as `true`/`false`. */
export function queryString(query: CallInput["query"] = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, Array.isArray(value) ? value.map(String).join(",") : String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason;
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts (with the signal's reason). */
export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class AttemptTimeout extends Error {
  constructor() {
    super("timeout");
  }
}

interface Answer {
  status: number;
  headers: Headers;
  text: string;
}

/** The request pipeline: URL, headers, Idempotency-Key, per-attempt timeout, retries, error mapping. */
export class HttpClient {
  // An ES private field: the API key never shows in console.log, util.inspect or JSON.stringify of a client.
  readonly #config: HttpConfig;

  constructor(config: HttpConfig) {
    this.#config = config;
  }

  get baseUrl(): string {
    return this.#config.baseUrl;
  }

  get fetchFn(): FetchLike {
    return this.#config.fetch;
  }

  get defaultTimeoutMs(): number {
    return this.#config.timeoutMs;
  }

  async call<T>(operationId: OperationId, input: CallInput = {}): Promise<T> {
    const op = OPERATIONS[operationId];
    const options = input.options ?? {};
    const path = fillPath(op.path, input.path);
    const url = `${this.#config.baseUrl}${path}${queryString(input.query)}`;

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (!MANAGED_HEADERS.has(name.toLowerCase())) headers[name] = value;
    }
    // Node's fetch adds "Cache-Control: no-cache" to a request that carries If-None-Match, and the API (Express) then
    // never answers 304: a caller's own If-None-Match goes with max-age=0 instead (unless they chose a Cache-Control).
    const names = Object.keys(headers).map((n) => n.toLowerCase());
    if (names.includes("if-none-match") && !names.includes("cache-control")) headers["Cache-Control"] = "max-age=0";
    headers["Accept"] = "application/json";
    headers["User-Agent"] = this.#config.userAgent;
    headers["X-API-Key"] = this.#config.apiKey;
    let body: string | undefined;
    if (input.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(input.body);
    }
    if (op.retry === "idempotency-key") {
      const key = options.idempotencyKey ?? newIdempotencyKey();
      if (typeof key !== "string" || !IDEMPOTENCY_KEY_RE.test(key)) {
        throw new TypeError("idempotencyKey must be 1-128 visible ASCII characters");
      }
      headers["Idempotency-Key"] = key;
    } else if (options.idempotencyKey != null) {
      throw new TypeError(`${operationId} takes no idempotencyKey`);
    }

    const conditional = op.retry === "if-version" && input.conditional === true;
    const retryable = op.retry === "safe" || op.retry === "idempotency-key" || conditional;
    const maxRetries = options.maxRetries === undefined ? this.#config.retry.maxRetries : intInRange(options.maxRetries, "maxRetries", 0, MAX_RETRIES);
    const settings: RetrySettings = { ...this.#config.retry, maxRetries: retryable ? maxRetries : 0 };
    const timeoutMs =
      options.timeoutMs !== undefined
        ? intInRange(options.timeoutMs, "timeoutMs", 1, MAX_TIMER_MS)
        : "timeoutMs" in op
          ? Math.max(op.timeoutMs, this.#config.timeoutMs)
          : this.#config.timeoutMs;
    const signal = options.signal;
    const write = op.method !== "GET" && !("read" in op);
    const meta = { operationId, method: op.method, path, idempotencyKey: headers["Idempotency-Key"] ?? null };
    // Set once an attempt of a write ended without telling whether it was applied (no answer, 500, 502, 504).
    let unknownSoFar = false;

    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw this.abortedError(meta, attempt - 1, abortReason(signal), write && unknownSoFar);
      let error: SplatterVaultError;
      try {
        const answer = await this.send(url, { method: op.method, headers, body, redirect: "manual" }, timeoutMs, signal);
        if (answer.status >= 200 && answer.status < 300) return this.parseSuccess<T>(answer, meta, attempt);
        if (answer.status >= 300 && answer.status < 400 && answer.status !== 304) {
          // Never followed: a redirect would carry X-API-Key to wherever it points (fetch drops only Authorization),
          // and a 301/302 turns a POST into a GET of another route. Not retried.
          throw this.redirectError(answer, meta, attempt, write && unknownSoFar);
        }
        error = this.errorFromAnswer(answer, meta, attempt);
      } catch (err) {
        if (err instanceof SplatterVaultError) throw err;
        // An abort while the request was out: it may have arrived.
        if (signal?.aborted) throw this.abortedError(meta, attempt, abortReason(signal), write);
        error =
          err instanceof AttemptTimeout
            ? new SplatterVaultError({
                ...meta,
                status: 0,
                code: SDK_ERROR_CODES.timeout,
                message: `timeout: no answer from SplatterVault within ${timeoutMs} ms`,
                attempts: attempt
              })
            : new SplatterVaultError({
                ...meta,
                status: 0,
                code: SDK_ERROR_CODES.networkError,
                message: `network_error: no answer from SplatterVault (${err instanceof Error ? err.message : String(err)})`,
                attempts: attempt,
                cause: err
              });
      }
      if (write && (error.isNetworkError || OUTCOME_UNKNOWN_STATUSES.has(error.status))) unknownSoFar = true;

      // A resent change that meets a conflict with its own earlier send.
      const resentConflict = attempt > 1 && error.status === 409;
      if (conditional && resentConflict && error.code === "version_conflict") {
        // The second send of an ifVersion write: the first may have been applied after all (its own new version).
        throw error.with({
          code: SDK_ERROR_CODES.outcomeUnknown,
          message: `outcome_unknown (HTTP 409): this write was sent again and met version_conflict; the first send may have been applied. Read the data again.`,
          outcomeUnknown: true
        });
      }
      // The same key with a byte-identical body can only conflict with its own send still in progress.
      const inProgress = op.retry === "idempotency-key" && resentConflict && error.code === "idempotency_conflict";

      let transient = error.isTransient || inProgress;
      // ifVersion writes: only an answer that proves nothing was applied may be sent again (unknown-outcome rule).
      if (conditional && !NOT_APPLIED_STATUSES.has(error.status)) transient = false;
      const delay = retryDelay(error, attempt, settings, undefined, transient);
      if (delay === null) throw error.with({ outcomeUnknown: write && (unknownSoFar || inProgress) });
      try {
        await sleep(delay, signal);
      } catch (reason) {
        throw this.abortedError(meta, attempt, reason, write && unknownSoFar);
      }
    }
  }

  /** One attempt: the answer with its whole body, within `timeoutMs`. Throws AttemptTimeout or the fetch error. */
  private async send(url: string, init: RequestInit, timeoutMs: number, signal: AbortSignal | undefined): Promise<Answer> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new AttemptTimeout());
    }, timeoutMs);
    const onAbort = () => controller.abort(abortReason(signal as AbortSignal));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await this.#config.fetch(url, { ...init, signal: controller.signal });
      const text = await res.text();
      return { status: res.status, headers: res.headers, text };
    } catch (err) {
      if (timedOut) throw new AttemptTimeout();
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private parseSuccess<T>(answer: Answer, meta: { operationId: string; method: string; path: string; idempotencyKey: string | null }, attempt: number): T {
    if (answer.status === 204 || answer.text.trim() === "") return undefined as T;
    try {
      return JSON.parse(answer.text) as T;
    } catch (err) {
      throw new SplatterVaultError({
        ...meta,
        status: answer.status,
        code: SDK_ERROR_CODES.invalidResponse,
        message: `invalid_response: the answer (HTTP ${answer.status}) is not JSON`,
        requestId: answer.headers.get("x-request-id"),
        attempts: attempt,
        cause: err
      });
    }
  }

  private errorFromAnswer(
    answer: Answer,
    meta: { operationId: string; method: string; path: string; idempotencyKey: string | null },
    attempt: number
  ): SplatterVaultError {
    let parsed: unknown;
    if (answer.text.trim() !== "") {
      try {
        parsed = JSON.parse(answer.text);
      } catch {
        parsed = undefined; // an HTML page from a proxy, for example: never quoted into the message
      }
    }
    const read = readErrorBody(parsed);
    const label = read.code ?? read.errorName ?? `HTTP ${answer.status}`;
    const sentence = read.message ?? `SplatterVault answered HTTP ${answer.status}`;
    return new SplatterVaultError({
      ...meta,
      status: answer.status,
      code: read.code,
      message: `${label} (HTTP ${answer.status}): ${sentence}`,
      details: read.details,
      retryAfter: parseRetryAfter(answer.headers.get("retry-after")),
      requestId: answer.headers.get("x-request-id"),
      errorName: read.errorName,
      errors: read.errors,
      body: parsed,
      attempts: attempt
    });
  }

  private abortedError(
    meta: { operationId: string; method: string; path: string; idempotencyKey: string | null },
    attempts: number,
    reason: unknown,
    outcomeUnknown: boolean
  ): SplatterVaultError {
    return new SplatterVaultError({
      ...meta,
      status: 0,
      code: SDK_ERROR_CODES.aborted,
      message: "aborted: the call was aborted by its signal",
      attempts,
      outcomeUnknown,
      cause: reason
    });
  }

  private redirectError(
    answer: Answer,
    meta: { operationId: string; method: string; path: string; idempotencyKey: string | null },
    attempt: number,
    outcomeUnknown: boolean
  ): SplatterVaultError {
    const location = answer.headers.get("location");
    return new SplatterVaultError({
      ...meta,
      status: answer.status,
      code: SDK_ERROR_CODES.redirectNotFollowed,
      message: `redirect_not_followed (HTTP ${answer.status}): SplatterVault answered a redirect, which the SDK never follows (check baseUrl)`,
      details: { location },
      requestId: answer.headers.get("x-request-id"),
      attempts: attempt,
      outcomeUnknown
    });
  }
}

