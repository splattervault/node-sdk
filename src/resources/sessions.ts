import { SplatterVaultError } from "../core/errors.js";
import { type HttpClient, type RequestOptions, sleep } from "../core/http.js";
import { intInRange, MAX_TIMER_MS } from "../core/validate.js";
import type {
  CancelScheduleAnswer,
  CreateCreditSessionRequest,
  GetSessionQuery,
  LaunchArgument,
  ListMySessionsQuery,
  ListSessionsQuery,
  PoolClaimAnswer,
  PoolClaimRequest,
  RescheduleSessionRequest,
  ServerSession,
  StopCreditSessionAnswer
} from "../types.js";

/** A session id (the `id` of a {@link ServerSession}). */
export type SessionId = number | string;

/**
 * A session as {@link Sessions.waitUntilReady} answers it: the same as {@link ServerSession}, whose `ready`, `readyAt`
 * and `readyDeadlineAt` say whether (and since when) its game has said it is ready for players.
 */
export type ReadySession = ServerSession;

/** Options of {@link Sessions.waitUntilReady}. */
export interface WaitUntilReadyOptions {
  /** How long to wait in all, 1 to 2147483647 ms (default 300,000: five minutes). */
  timeoutMs?: number;
  /**
   * The first wait between two reads, 250 to 60,000 ms (default 2,000); it grows by half each time, up to 10 s (or
   * up to `intervalMs` when that is longer).
   */
  intervalMs?: number;
  /**
   * true (default): wait until the GAME says it is ready (`ready`), not just until the server is up (status Active).
   * A game that sends no ready signal is returned once its `readyDeadlineAt` has passed, with `ready: false`.
   * false: return as soon as the session is Active (the Unity SDK's `WaitForServerReady` default).
   */
  waitForGameReady?: boolean;
  /** Stops waiting (and any read under way): rejects with code `aborted`. */
  signal?: AbortSignal;
  /** Called with each session read, e.g. to show progress. */
  onPoll?: (session: ReadySession) => void;
}

/** Why {@link Sessions.waitUntilReady} gave up. */
export type SessionWaitErrorCode =
  /** The session ended (status `Not Active`) before it was ready: see `stopReason` (e.g. `GAME_CRASH`). */
  | "session_ended"
  /** It was not ready within `timeoutMs`; `session` holds the last state read. */
  | "wait_timeout";

/** {@link Sessions.waitUntilReady} gave up: the session ended, or it was not ready in time. */
export class SessionWaitError extends Error {
  override readonly name = "SessionWaitError";
  /** The session's id. */
  readonly sessionId: number | string;
  /** The session's last status read (`Pending`, `Active`, `Not Active`, `Scheduled`, …), or null if none was read. */
  readonly sessionStatus: string | null;
  /** The session's stop reason when it ended (e.g. `GAME_CRASH`, `IDLE_TIMEOUT`), else null. */
  readonly stopReason: string | null;
  /** The last session read, or null. */
  readonly session: ReadySession | null;

  constructor(
    /** `session_ended` or `wait_timeout`. */
    readonly code: SessionWaitErrorCode,
    sessionId: number | string,
    session: ReadySession | null,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.sessionId = sessionId;
    this.session = session;
    this.sessionStatus = session?.status ?? null;
    this.stopReason = session?.stopReason ?? null;
  }
}

const MAX_POLL_INTERVAL_MS = 10_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

/** Ready to hand to players: Active, and (when asked) the game said ready, or has no readiness fields, or its deadline passed. */
function isReady(session: ReadySession, waitForGameReady: boolean, nowMs: number): boolean {
  if (session.status !== "Active") return false;
  if (!waitForGameReady || session.ready === true || session.ready === undefined) return true;
  const deadline = session.readyDeadlineAt ? Date.parse(session.readyDeadlineAt) : Number.NaN;
  return Number.isFinite(deadline) && nowMs >= deadline;
}

/**
 * Subscription-billed game-server sessions (`/subscriptions/sessions`): the same calls as {@link Sessions}, for
 * accounts with a server subscription. Most studios use credit sessions ({@link Sessions}).
 */
export class SubscriptionSessions {
  /** @internal */
  constructor(private readonly http: HttpClient) {}

  /**
   * Starts a dedicated server for a match, billed to the subscription. Never retried by the SDK (a repeat would start
   * a second server).
   * @see POST /subscriptions/sessions (`sessions.createSubscription`)
   */
  create(body: CreateCreditSessionRequest, options?: RequestOptions): Promise<ServerSession> {
    return this.http.call("sessions.createSubscription", { body, options });
  }

  /**
   * The subscription sessions, optionally of one organization and of some statuses (`"Active,Pending"`).
   * @see GET /subscriptions/sessions (`sessions.listSubscription`)
   */
  list(query?: ListSessionsQuery, options?: RequestOptions): Promise<ServerSession[]> {
    return this.http.call("sessions.listSubscription", { query, options });
  }

  /**
   * Stops a subscription session.
   * @see POST /subscriptions/sessions/{sessionId}/stop (`sessions.stopSubscription`)
   */
  stop(sessionId: SessionId, options?: RequestOptions): Promise<ServerSession> {
    return this.http.call("sessions.stopSubscription", { path: { sessionId }, options });
  }

  /**
   * Sets a session's friendly name (at most 255 characters).
   * @see PUT /subscriptions/sessions/{sessionId}/friendly-name (`sessions.renameSubscription`)
   */
  rename(sessionId: SessionId, friendlyName: string, options?: RequestOptions): Promise<ServerSession> {
    return this.http.call("sessions.renameSubscription", { path: { sessionId }, body: { friendlyName }, options });
  }

  /**
   * Moves a scheduled session's start and end, or sets an active session's end.
   * @see PUT /subscriptions/sessions/{sessionId}/schedule (`sessions.rescheduleSubscription`)
   */
  reschedule(sessionId: SessionId, body: RescheduleSessionRequest, options?: RequestOptions): Promise<ServerSession> {
    return this.http.call("sessions.rescheduleSubscription", { path: { sessionId }, body, options });
  }

  /**
   * Cancels a scheduled session (it becomes Not Active).
   * @see POST /subscriptions/sessions/{sessionId}/cancel-schedule (`sessions.cancelScheduledSubscription`)
   */
  cancelSchedule(sessionId: SessionId, options?: RequestOptions): Promise<CancelScheduleAnswer> {
    return this.http.call("sessions.cancelScheduledSubscription", { path: { sessionId }, options });
  }
}

/**
 * Game-server sessions: dedicated servers SplatterVault starts for your matches, billed in credits (your
 * organization's credits with an organization API key, which also fills in `organizationId`).
 *
 * These routes refuse in the platform's shape (`code` null; `errorName` such as `CONFLICT` and the HTTP status tell
 * what happened) and set no rate limit of their own: they never answer 429.
 */
export class Sessions {
  /** Subscription-billed sessions. */
  readonly subscription: SubscriptionSessions;

  /** @internal */
  constructor(private readonly http: HttpClient) {
    this.subscription = new SubscriptionSessions(http);
  }

  /**
   * Starts a dedicated server for a match (status `Pending` until it is up; poll {@link Sessions.get} for
   * `connection`). Credits are billed per minute while it runs. Never retried by the SDK: a repeat would start a second
   * server, so on a network error look for it with {@link Sessions.list} before trying again.
   * @see POST /credits/sessions (`sessions.createCredit`)
   */
  create(body: CreateCreditSessionRequest, options?: RequestOptions): Promise<ServerSession> {
    return this.http.call("sessions.createCredit", { body, options });
  }

  /**
   * The credit sessions, optionally of one organization (0: personal only) and of some statuses (`"Active,Pending"`).
   * @see GET /credits/sessions (`sessions.listCredit`)
   */
  list(query?: ListSessionsQuery, options?: RequestOptions): Promise<ServerSession[]> {
    return this.http.call("sessions.listCredit", { query, options });
  }

  /**
   * One session with its connection details. `{ slim: true }` leaves out its matches.
   * @see GET /game-sessions/{id} (`sessions.get`)
   */
  get(sessionId: SessionId, query?: GetSessionQuery, options?: RequestOptions): Promise<ServerSession> {
    return this.http.call("sessions.get", { path: { id: sessionId }, query, options });
  }

  /**
   * Waits until a session is ready for players and answers it: polls {@link Sessions.get} (slim) with a growing
   * interval, from `intervalMs` up to 10 s. "Ready" is status `Active` and, by default, the game's own ready signal
   * (`ready: true`); a game with no ready signal is returned once its `readyDeadlineAt` (server up + 300 s) passes,
   * with `ready: false`. The counterpart of the Unity SDK's `WaitForServerReady`.
   *
   * Rejects with a {@link SessionWaitError}: `session_ended` as soon as the session is `Not Active` (see its
   * `stopReason`), or `wait_timeout` after `timeoutMs` (default five minutes). A read that fails transiently is
   * tolerated twice in a row; any other refusal (e.g. 404) rejects at once. An aborted `signal` rejects with a
   * `SplatterVaultError` of code `aborted`.
   *
   * ```ts
   * const session = await sv.sessions.create({ gameTypeConfigKey: "my-game", region: "NYC3" });
   * const ready = await sv.sessions.waitUntilReady(session.id);
   * console.log(ready.connection?.host, ready.connection?.primaryPort);
   * ```
   */
  async waitUntilReady(sessionId: SessionId, options: WaitUntilReadyOptions = {}): Promise<ReadySession> {
    const timeoutMs = intInRange(options.timeoutMs ?? 300_000, "timeoutMs", 1, MAX_TIMER_MS);
    let interval = intInRange(options.intervalMs ?? 2_000, "intervalMs", 250, 60_000);
    const maxInterval = Math.max(MAX_POLL_INTERVAL_MS, interval);
    const waitForGameReady = options.waitForGameReady !== false;
    const signal = options.signal;
    const giveUpAt = Date.now() + timeoutMs;
    let last: ReadySession | null = null;
    let failures = 0;
    for (;;) {
      const remaining = giveUpAt - Date.now();
      try {
        const session = await this.get(sessionId, { slim: true }, {
          ...(signal ? { signal } : {}),
          timeoutMs: Math.max(1, Math.min(this.http.defaultTimeoutMs, remaining))
        });
        failures = 0;
        last = session;
        options.onPoll?.(session);
        if (session.status === "Not Active") {
          const reason = session.stopReason ? ` (stop reason: ${session.stopReason})` : "";
          throw new SessionWaitError("session_ended", sessionId, session, `session ${sessionId} ended before it was ready${reason}`);
        }
        if (isReady(session, waitForGameReady, Date.now())) return session;
      } catch (err) {
        if (!(err instanceof SplatterVaultError) || err.code === "aborted") throw err;
        // A transient failure (after the SDK's own retries) is tolerated a couple of times; anything else is real.
        if (!err.isTransient || ++failures >= MAX_CONSECUTIVE_POLL_FAILURES || Date.now() >= giveUpAt) throw err;
      }
      const left = giveUpAt - Date.now();
      if (left <= 0) {
        const state = last ? ` (last status: ${last.status}${last.status === "Active" && waitForGameReady ? ", game not ready yet" : ""})` : "";
        throw new SessionWaitError("wait_timeout", sessionId, last, `session ${sessionId} was not ready within ${timeoutMs} ms${state}`);
      }
      try {
        await sleep(Math.min(interval, left), signal);
      } catch (reason) {
        throw new SplatterVaultError({
          status: 0,
          code: "aborted",
          message: "aborted: the call was aborted by its signal",
          operationId: "sessions.get",
          method: "GET",
          path: `/game-sessions/${encodeURIComponent(String(sessionId))}`,
          cause: reason
        });
      }
      interval = Math.min(Math.round(interval * 1.5), maxInterval);
    }
  }

  /**
   * The sessions this key (or account) created, optionally of one game type and status.
   * @see GET /game-sessions/my-sessions (`sessions.listMine`)
   */
  listMine(query?: ListMySessionsQuery, options?: RequestOptions): Promise<ServerSession[]> {
    return this.http.call("sessions.listMine", { query, options });
  }

  /**
   * Stops a credit session and bills it: answers the session, its hours and its cost.
   * @see POST /credits/sessions/{sessionId}/stop (`sessions.stopCredit`)
   */
  stop(sessionId: SessionId, options?: RequestOptions): Promise<StopCreditSessionAnswer> {
    return this.http.call("sessions.stopCredit", { path: { sessionId }, options });
  }

  /**
   * Sets a session's friendly name (at most 255 characters).
   * @see PUT /credits/sessions/{sessionId}/friendly-name (`sessions.renameCredit`)
   */
  rename(sessionId: SessionId, friendlyName: string, options?: RequestOptions): Promise<ServerSession> {
    return this.http.call("sessions.renameCredit", { path: { sessionId }, body: { friendlyName }, options });
  }

  /**
   * Moves a scheduled session's start and end, or sets an active session's end.
   * @see PUT /credits/sessions/{sessionId}/schedule (`sessions.rescheduleCredit`)
   */
  reschedule(sessionId: SessionId, body: RescheduleSessionRequest, options?: RequestOptions): Promise<ServerSession> {
    return this.http.call("sessions.rescheduleCredit", { path: { sessionId }, body, options });
  }

  /**
   * Cancels a scheduled credit session (it becomes Not Active).
   * @see POST /credits/sessions/{sessionId}/cancel-schedule (`sessions.cancelScheduledCredit`)
   */
  cancelSchedule(sessionId: SessionId, options?: RequestOptions): Promise<CancelScheduleAnswer> {
    return this.http.call("sessions.cancelScheduledCredit", { path: { sessionId }, options });
  }
}

/**
 * What a `409` from {@link ServerPools.claim} means (see {@link poolClaimConflict}):
 * - `"no_warm_server"`: no server of the pool is idle now. Start one with `sessions.create()` instead, or wait.
 * - `"busy"`: the claim met a moment of contention (another claim of the pool was running, the idle server could not
 *   take the session or was drained meanwhile). Nothing was claimed: trying the claim again shortly is safe.
 */
export type PoolClaimConflict = "no_warm_server" | "busy";

/**
 * Tells the two kinds of `409` from {@link ServerPools.claim} apart, or answers null for any other error. The API
 * answers every claim conflict as `{ name: "CONFLICT", message }` and documents that only the message tells them apart:
 * "No warm server available in this pool" (none idle) versus the messages that end in "— retry" ("Pool claim is busy
 * — retry", "No warm server connected in this pool — retry", …). An unknown 409 message counts as `"no_warm_server"`
 * (the safe reading: fall back instead of claiming in a loop).
 *
 * ```ts
 * try {
 *   return await sv.serverPools.claim(poolId, { mode: "Ranked" });
 * } catch (err) {
 *   const conflict = poolClaimConflict(err);
 *   if (conflict === "busy") return await sv.serverPools.claim(poolId, { mode: "Ranked" }); // once, after a moment
 *   if (conflict === "no_warm_server") return await startNewSession();
 *   throw err;
 * }
 * ```
 */
export function poolClaimConflict(err: unknown): PoolClaimConflict | null {
  if (!(err instanceof SplatterVaultError) || err.status !== 409 || err.operationId !== "serverPools.claim") return null;
  const body = err.body as { message?: unknown } | undefined;
  const message = typeof body?.message === "string" ? body.message : "";
  return /\bretry\s*[.!]?\s*$/i.test(message) ? "busy" : "no_warm_server";
}

/** Warm server pools: servers already running, claimed for a match in seconds. */
export class ServerPools {
  /** @internal */
  constructor(private readonly http: HttpClient) {}

  /**
   * Claims a warm server from pool `poolId` for a match: answers the new session's id, the pool instance and its
   * `connection` (null until reachable). Needs a key holding org:manage_pools (with an organization API key).
   *
   * Never retried by the SDK: a repeat after a lost answer could claim a second server. A `409` claimed nothing:
   * {@link poolClaimConflict} says whether no server is idle (`"no_warm_server"`: start a session instead) or the
   * claim met contention (`"busy"`: you may try again shortly). Like every session route it never answers 429.
   * @see POST /server-pools/{id}/claim (`serverPools.claim`)
   */
  claim(poolId: number | string, body?: PoolClaimRequest, options?: RequestOptions): Promise<PoolClaimAnswer> {
    return this.http.call("serverPools.claim", { path: { id: poolId }, body: body ?? {}, options });
  }
}

/** Game types (the games SplatterVault hosts servers for). */
export class Games {
  /** @internal */
  constructor(private readonly http: HttpClient) {}

  /**
   * The launch arguments a session of this game may set (`userConfigurable`), by the game's key (or its id).
   * @see GET /game-types/{id}/configurable-args (`games.getConfigurableArgs`)
   */
  getConfigurableArgs(game: string | number, options?: RequestOptions): Promise<LaunchArgument[]> {
    return this.http.call("games.getConfigurableArgs", { path: { id: game }, options });
  }
}
