// Website-job follow-ups (2026-11-15): corrected holdings-import schema, idempotencyKey null, sessions.waitUntilReady.
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ReadySession, SessionWaitError, SplatterVault, SplatterVaultError, type StoreHoldingsImportRequest } from "../src/index.js";
import { BASE, KEY, mockFetch, type Reply } from "./helpers/mockFetch.js";

const PLAYER = "8f14e45f-ceea-467f-a8f1-2a0e3f5b1c9d";
const txn = { txn: { id: "t" }, changes: [], balances: [], items: [], shortfall: [], replayed: false };
const client = (fetch: ReturnType<typeof mockFetch>["fetch"]) => new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch, retry: { baseDelayMs: 1, maxDelayMs: 1 } });

describe("holdings import balances are { CODE: amount }", () => {
  it("type-checks and is sent as a map", async () => {
    const body: StoreHoldingsImportRequest = { gameId: 42, dryRun: true, rows: [{ playerId: PLAYER, balances: { GOLD: 1200, GEMS: 5 } }] };
    // @ts-expect-error the old (wrong) list shape no longer type-checks
    const wrong: StoreHoldingsImportRequest = { gameId: 42, dryRun: true, rows: [{ playerId: PLAYER, balances: [{ currency: "GOLD", amount: 1 }] }] };
    void wrong;
    const { fetch, calls } = mockFetch({ status: 200, body: { dryRun: true, counts: {}, results: [] } });
    await client(fetch).store.importHoldings(body);
    expect((calls[0]!.body as StoreHoldingsImportRequest).rows[0]!.balances).toEqual({ GOLD: 1200, GEMS: 5 });
  });
});

describe("idempotencyKey: null", () => {
  it("err.idempotencyKey (string | null) can be passed straight back; null makes a new key", async () => {
    const { fetch, calls } = mockFetch({ status: 201, body: txn });
    const sv = client(fetch);
    const err = new SplatterVaultError({ status: 0, code: "timeout", message: "", operationId: "o", method: "POST", path: "/", idempotencyKey: null });
    await sv.store.grant(PLAYER, { lines: [{ currency: "GOLD", amount: 1 }] }, { idempotencyKey: err.idempotencyKey });
    expect(calls[0]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    await sv.store.grant(PLAYER, { lines: [{ currency: "GOLD", amount: 1 }] }, { idempotencyKey: "keep-me" });
    expect(calls[1]!.headers["idempotency-key"]).toBe("keep-me");
    // null on an operation that takes no key is "none", not an error.
    await expect(client(mockFetch({ status: 200, body: { balance: 1 } }).fetch).billing.getCredits({ idempotencyKey: null } as never)).resolves.toEqual({
      balance: 1
    });
  });
});

describe("sessions.waitUntilReady", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const session = (fields: Partial<ReadySession>): Reply => ({
    status: 200,
    body: { id: 7, status: "Pending", readyAt: null, readyDeadlineAt: null, ready: false, ...fields }
  });

  /** Runs `p` while advancing fake time in steps until it settles. */
  async function settle<T>(p: Promise<T>, stepMs = 1000, maxSteps = 2000): Promise<T> {
    let done = false;
    const out = p.finally(() => {
      done = true;
    });
    for (let i = 0; i < maxSteps && !done; i++) await vi.advanceTimersByTimeAsync(stepMs);
    return out;
  }

  it("polls GET /game-sessions/{id}?slim=true until the game says ready, with a growing interval", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const at: number[] = [];
    const { fetch, calls } = mockFetch(
      (_r, i) => {
        at.push(Date.now());
        return i < 2 ? session({ status: "Pending" }) : i < 4 ? session({ status: "Active" }) : session({ status: "Active", ready: true, readyAt: "2026-11-15T01:00:00Z" });
      }
    );
    const seen: string[] = [];
    const ready = await settle(client(fetch).sessions.waitUntilReady(7, { onPoll: (s) => seen.push(`${s.status}/${String(s.ready)}`) }), 100);
    expect(ready).toMatchObject({ id: 7, status: "Active", ready: true });
    expect(calls).toHaveLength(5);
    expect(calls.every((c) => c.method === "GET" && c.url === `${BASE}/game-sessions/7?slim=true`)).toBe(true);
    expect(seen).toEqual(["Pending/false", "Pending/false", "Active/false", "Active/false", "Active/true"]);
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    expect(gaps).toEqual([2000, 3000, 4500, 6750]);
  });

  it("caps the interval at 10 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const at: number[] = [];
    const { fetch } = mockFetch((_r, i) => {
      at.push(Date.now());
      return i < 8 ? session({ status: "Pending" }) : session({ status: "Active", ready: true });
    });
    await settle(client(fetch).sessions.waitUntilReady(7, { intervalMs: 4000 }), 500);
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    expect(gaps).toEqual([4000, 6000, 9000, 10000, 10000, 10000, 10000, 10000]);
  });

  it("waitForGameReady: false returns as soon as the session is Active", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { fetch, calls } = mockFetch(session({ status: "Pending" }), session({ status: "Active", ready: false }));
    await expect(settle(client(fetch).sessions.waitUntilReady(7, { waitForGameReady: false }), 100)).resolves.toMatchObject({ status: "Active", ready: false });
    expect(calls).toHaveLength(2);
  });

  it("returns an Active session whose ready deadline has passed (a game with no ready signal), with ready: false", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-11-15T01:00:00Z"));
    const { fetch } = mockFetch(session({ status: "Active", ready: false, readyDeadlineAt: "2026-11-15T01:00:05Z" }));
    await expect(settle(client(fetch).sessions.waitUntilReady(7), 500)).resolves.toMatchObject({ ready: false });
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse("2026-11-15T01:00:05Z"));
  });

  it("an answer without readiness fields (an older API) counts Active as ready", async () => {
    const { fetch } = mockFetch({ status: 200, body: { id: 7, status: "Active" } });
    await expect(client(fetch).sessions.waitUntilReady(7)).resolves.toMatchObject({ status: "Active" });
  });

  it("rejects with session_ended, the status and the stop reason, as soon as the session is Not Active", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { fetch, calls } = mockFetch(session({ status: "Pending" }), session({ status: "Not Active", stopReason: "GAME_CRASH" }));
    const err = await settle(client(fetch).sessions.waitUntilReady(7).catch((e: unknown) => e), 100);
    expect(err).toBeInstanceOf(SessionWaitError);
    expect(err).toMatchObject({ code: "session_ended", sessionId: 7, sessionStatus: "Not Active", stopReason: "GAME_CRASH" });
    expect((err as SessionWaitError).message).toContain("GAME_CRASH");
    expect(calls).toHaveLength(2);
  });

  it("rejects with wait_timeout after timeoutMs, carrying the last session", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { fetch, calls } = mockFetch(session({ status: "Active", ready: false }));
    const started = Date.now();
    const err = await settle(client(fetch).sessions.waitUntilReady(7, { timeoutMs: 30_000 }).catch((e: unknown) => e), 250);
    expect(err).toMatchObject({ code: "wait_timeout", sessionStatus: "Active", session: { ready: false } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(30_000);
    expect(Date.now() - started).toBeLessThan(31_000);
    expect(calls.length).toBeLessThanOrEqual(8);
  });

  it("tolerates two transient read failures in a row, rejects on the third or on a non-transient one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const busy: Reply = { status: 503, body: { error: "x", message: "m" } };
    const sv = (f: ReturnType<typeof mockFetch>) => new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch: f.fetch, maxRetries: 0 });
    const ok = mockFetch(busy, busy, session({ status: "Active", ready: true }));
    await expect(settle(sv(ok).sessions.waitUntilReady(7), 100)).resolves.toMatchObject({ ready: true });
    const bad = mockFetch(busy, busy, busy);
    await expect(settle(sv(bad).sessions.waitUntilReady(7).catch((e: unknown) => e), 100)).resolves.toMatchObject({ status: 503 });
    expect(bad.calls).toHaveLength(3);
    const missing = mockFetch({ status: 404, body: { name: "NOT_FOUND", message: "Game session not found" } });
    await expect(sv(missing).sessions.waitUntilReady(7)).rejects.toMatchObject({ status: 404, errorName: "NOT_FOUND" });
    expect(missing.calls).toHaveLength(1);
  });

  it("an abort ends the wait at once, during a read or between reads", async () => {
    const between = new AbortController();
    const { fetch, calls } = mockFetch(session({ status: "Pending" }));
    const p = client(fetch).sessions.waitUntilReady(7, { signal: between.signal });
    await new Promise((r) => setTimeout(r, 20));
    between.abort();
    await expect(p).rejects.toMatchObject({ code: "aborted" });
    expect(calls).toHaveLength(1);

    const during = new AbortController();
    const hang = mockFetch((req) => new Promise<Reply>((_r, reject) => req.signal?.addEventListener("abort", () => reject(req.signal?.reason))));
    const q = client(hang.fetch).sessions.waitUntilReady(7, { signal: during.signal });
    await new Promise((r) => setTimeout(r, 20));
    during.abort();
    await expect(q).rejects.toMatchObject({ code: "aborted" });
  });

  it("validates its options", async () => {
    const sv = client(mockFetch(session({})).fetch);
    await expect(sv.sessions.waitUntilReady(7, { intervalMs: 10 })).rejects.toThrow(RangeError);
    await expect(sv.sessions.waitUntilReady(7, { timeoutMs: Number.NaN })).rejects.toThrow(RangeError);
    await expect(sv.sessions.waitUntilReady(7, { timeoutMs: 2 ** 31 })).rejects.toThrow(RangeError);
  });
});
