import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { backoffMs, retryDelay } from "../src/core/retry.js";
import { SplatterVault, SplatterVaultError } from "../src/index.js";
import { BASE, KEY, mockFetch, type Reply } from "./helpers/mockFetch.js";

const PLAYER = "8f14e45f-ceea-467f-a8f1-2a0e3f5b1c9d";
const txn = { txn: { id: "t" }, changes: [], balances: [], items: [], shortfall: [], replayed: false };
const studioErr = (status: number, error: string, headers?: Record<string, string>): Reply => ({
  status,
  body: { error, message: `${error} sentence` },
  headers
});

/** A client whose retries wait 1 ms (the backoff itself is tested on its own below). */
function client(fetch: ReturnType<typeof mockFetch>["fetch"], extra: Partial<ConstructorParameters<typeof SplatterVault>[0]> = {}) {
  return new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch, retry: { baseDelayMs: 1, maxDelayMs: 2 }, ...extra });
}

describe("which calls are retried", () => {
  it("retries a GET on 503, 502, 504 and 429, then answers", async () => {
    const { fetch, calls } = mockFetch(
      studioErr(503, "data_busy"),
      { status: 502, text: "<html>Bad Gateway</html>" },
      { status: 504 },
      studioErr(429, "rate_limited", { "Retry-After": "0" }),
      { status: 200, body: { balance: 1 } }
    );
    await expect(client(fetch, { maxRetries: 4 }).billing.getCredits()).resolves.toEqual({ balance: 1 });
    expect(calls).toHaveLength(5);
  });

  it("retries a network error on a GET", async () => {
    const { fetch, calls } = mockFetch(new TypeError("fetch failed"), { status: 200, body: [] });
    await expect(client(fetch).sessions.list()).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("gives up after maxRetries and throws the last error with its attempt count", async () => {
    const { fetch, calls } = mockFetch(studioErr(503, "data_busy"));
    const err = await client(fetch, { maxRetries: 3 }).playerData.getGameData(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SplatterVaultError);
    expect(err).toMatchObject({ status: 503, code: "data_busy", attempts: 4 });
    expect(calls).toHaveLength(4);
  });

  it("never retries 400, 401, 403, 404, 409 or 422 (500 is transient: see review-fixes.test.ts)", async () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      const { fetch, calls } = mockFetch(studioErr(status, "nope"));
      await expect(client(fetch).store.getCatalog()).rejects.toMatchObject({ status, attempts: 1 });
      expect(calls).toHaveLength(1);
    }
  });

  it("retries a store change with the SAME Idempotency-Key", async () => {
    const { fetch, calls } = mockFetch(new TypeError("socket hang up"), studioErr(503, "x"), { status: 201, body: txn });
    await client(fetch).store.grant(PLAYER, { lines: [{ currency: "GOLD", amount: 5 }] });
    expect(calls).toHaveLength(3);
    const keys = calls.map((c) => c.headers["idempotency-key"]);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls.map((c) => c.rawBody)).toEqual([calls[0]!.rawBody, calls[0]!.rawBody, calls[0]!.rawBody]);
  });

  it("keeps a caller's Idempotency-Key across retries", async () => {
    const { fetch, calls } = mockFetch(studioErr(429, "rate_limited", { "Retry-After": "0" }), { status: 200, body: { ...txn, replayed: true } });
    await expect(client(fetch).store.consume(PLAYER, { lines: [{ sku: "potion", quantity: 1 }] }, { idempotencyKey: "use:potion:1" })).resolves.toMatchObject({
      replayed: true
    });
    expect(calls.map((c) => c.headers["idempotency-key"])).toEqual(["use:potion:1", "use:potion:1"]);
  });

  it("never retries creating or stopping a session, claiming a pool server, signing in or erasing", async () => {
    const sv = (f: ReturnType<typeof mockFetch>) => client(f.fetch);
    const attempts = async (call: (c: SplatterVault) => Promise<unknown>) => {
      const f = mockFetch(studioErr(503, "busy"));
      await call(sv(f)).catch(() => undefined);
      const g = mockFetch(new TypeError("fetch failed"));
      await call(sv(g)).catch(() => undefined);
      return [f.calls.length, g.calls.length];
    };
    expect(await attempts((c) => c.sessions.create({ gameTypeConfigKey: "g" }))).toEqual([1, 1]);
    expect(await attempts((c) => c.sessions.stop(1))).toEqual([1, 1]);
    expect(await attempts((c) => c.sessions.subscription.create({}))).toEqual([1, 1]);
    expect(await attempts((c) => c.sessions.rename(1, "x"))).toEqual([1, 1]);
    expect(await attempts((c) => c.serverPools.claim(1))).toEqual([1, 1]);
    expect(await attempts((c) => c.players.signIn({ gameId: 1, externalId: "e" }))).toEqual([1, 1]);
    expect(await attempts((c) => c.players.erase(PLAYER))).toEqual([1, 1]);
    expect(await attempts((c) => c.store.syncMetaPurchases(PLAYER, { gameId: 1 }))).toEqual([1, 1]);
  });

  it("retries a data write only when every op carries ifVersion", async () => {
    const run = async (ops: Parameters<SplatterVault["playerData"]["update"]>[2]["ops"]) => {
      const { fetch, calls } = mockFetch(studioErr(503, "data_busy"), { status: 200, body: { results: [] } });
      await client(fetch).playerData.update(1, PLAYER, { ops }).catch(() => undefined);
      return calls.length;
    };
    expect(await run([{ op: "set", store: "player", key: "a", value: 1, ifVersion: 0 }, { op: "delete", store: "player", key: "b", ifVersion: 4 }])).toBe(2);
    expect(await run([{ op: "set", store: "player", key: "a", value: 1, ifVersion: 0 }, { op: "inc", store: "player", key: "n", by: 1 }])).toBe(1);
    expect(await run([{ op: "inc", store: "player", key: "n", by: 1 }])).toBe(1);

    const many = async (withVersion: boolean) => {
      const { fetch, calls } = mockFetch(studioErr(503, "data_busy"), { status: 200, body: { results: [] } });
      await client(fetch)
        .playerData.writeMany(1, {
          writes: [
            { player: PLAYER, ops: [{ op: "set", store: "player", key: "a", value: 1, ifVersion: 1 }] },
            { player: PLAYER, ops: [{ op: "set", store: "player", key: "b", value: 1, ...(withVersion ? { ifVersion: 2 } : {}) }] }
          ]
        })
        .catch(() => undefined);
      return calls.length;
    };
    expect(await many(true)).toBe(2);
    expect(await many(false)).toBe(1);

    const game = async (ifVersion?: number) => {
      const { fetch, calls } = mockFetch(studioErr(503, "data_busy"), { status: 200, body: { results: [] } });
      await client(fetch)
        .playerData.updateGameData(1, { ops: [{ op: "set", store: "public", key: "motd", value: "hi", ...(ifVersion === undefined ? {} : { ifVersion }) }] })
        .catch(() => undefined);
      return calls.length;
    };
    expect(await game(3)).toBe(2);
    expect(await game()).toBe(1);
  });

  it("retries the documented-safe writes: imports, lookups, clearing a player's data", async () => {
    const run = async (call: (c: SplatterVault) => Promise<unknown>) => {
      const { fetch, calls } = mockFetch(studioErr(503, "import_busy"), { status: 200, body: {} });
      await call(client(fetch));
      return calls.length;
    };
    expect(await run((c) => c.players.import({ gameId: 1, dryRun: true, rows: [{}] }))).toBe(2);
    expect(await run((c) => c.playerData.import(1, { dryRun: true, rows: [{ type: "gameData", store: "public", data: {} }] }))).toBe(2);
    expect(await run((c) => c.playerData.resolve(1, { refs: [PLAYER] }))).toBe(2);
    expect(await run((c) => c.playerData.getMany(1, { players: [PLAYER] }))).toBe(2);
    expect(await run((c) => c.store.importCatalog({ dryRun: true, format: "sv", rows: [{}] }))).toBe(2);
    expect(await run((c) => c.store.importHoldings({ gameId: 1, dryRun: true, rows: [{}] }))).toBe(2);
    expect(await run((c) => c.playerData.clear(1, PLAYER))).toBe(2);
  });

  it("maxRetries: 0 (client or call) turns retries off", async () => {
    const a = mockFetch(studioErr(503, "x"));
    await client(a.fetch, { maxRetries: 0 }).billing.getUsage().catch(() => undefined);
    expect(a.calls).toHaveLength(1);
    const b = mockFetch(studioErr(503, "x"));
    await client(b.fetch).billing.getUsage({ maxRetries: 0 }).catch(() => undefined);
    expect(b.calls).toHaveLength(1);
    const c = mockFetch(studioErr(503, "x"), studioErr(503, "x"), studioErr(503, "x"), { status: 200, body: {} });
    await client(c.fetch, { maxRetries: 0 }).billing.getUsage({ maxRetries: 3 });
    expect(c.calls).toHaveLength(4);
  });
});

describe("Retry-After and backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits exactly the Retry-After seconds, never less", async () => {
    const { fetch, calls } = mockFetch(studioErr(429, "rate_limited", { "Retry-After": "2" }), { status: 200, body: {} });
    const sv = new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch });
    const p = sv.store.getCatalog();
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await expect(p).resolves.toEqual({});
  });

  it("reads Retry-After as an HTTP date", async () => {
    vi.setSystemTime(new Date("2026-11-15T01:00:00.000Z"));
    const { fetch, calls } = mockFetch(
      studioErr(503, "data_busy", { "Retry-After": "Sun, 15 Nov 2026 01:00:03 GMT" }),
      { status: 200, body: {} }
    );
    const p = new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch }).playerData.getGameData(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({});
    expect(calls).toHaveLength(2);
  });

  it("does not wait out a Retry-After longer than maxRetryAfterMs: throws it with retryAfter", async () => {
    const { fetch, calls } = mockFetch(studioErr(429, "rate_limited", { "Retry-After": "60" }));
    const err = await new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch }).store.getCatalog().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "rate_limited", status: 429, retryAfter: 60 });
    expect(calls).toHaveLength(1);
  });

  it("backs off exponentially with jitter between half and all of the wait, capped", async () => {
    const settings = { maxRetries: 10, baseDelayMs: 500, maxDelayMs: 8000, maxRetryAfterMs: 10_000 };
    expect(backoffMs(1, settings, () => 0)).toBe(250);
    expect(backoffMs(1, settings, () => 1)).toBe(500);
    expect(backoffMs(2, settings, () => 1)).toBe(1000);
    expect(backoffMs(3, settings, () => 0.5)).toBe(1500);
    expect(backoffMs(9, settings, () => 1)).toBe(8000);
    expect(backoffMs(9, settings, () => 0)).toBe(4000);
    const err = new SplatterVaultError({ status: 502, code: null, message: "x", operationId: "o", method: "GET", path: "/" });
    expect(retryDelay(err, 3, { ...settings, maxRetries: 2 })).toBeNull();
    expect(retryDelay(err, 2, settings, () => 1)).toBe(1000);
  });

  it("the client's default backoff spaces the retries out", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const { fetch, calls } = mockFetch(studioErr(502, "x"), studioErr(502, "x"), { status: 200, body: {} });
    const p = new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch }).billing.getUsage();
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({});
    vi.restoreAllMocks();
  });
});
