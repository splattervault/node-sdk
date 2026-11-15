import { inspect } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseRetryAfter, readErrorBody } from "../src/core/errors.js";
import { SDK_VERSION, SplatterVault, SplatterVaultError } from "../src/index.js";
import { BASE, hangingFetch, KEY, mockFetch } from "./helpers/mockFetch.js";

const PLAYER = "8f14e45f-ceea-467f-a8f1-2a0e3f5b1c9d";
const sv = (fetch: ReturnType<typeof mockFetch>["fetch"], extra = {}) => new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch, ...extra });

describe("error mapping", () => {
  it("maps a studio refusal: status, code, message, details, requestId", async () => {
    const { fetch } = mockFetch({
      status: 409,
      body: { error: "version_conflict", message: "The data changed since you read it.", details: [{ store: "player", key: "coins", version: 7 }] },
      headers: { "x-request-id": "0123456789abcdef0123456789abcdef" }
    });
    const err = (await sv(fetch)
      .playerData.update(1, PLAYER, { ops: [{ op: "set", store: "player", key: "coins", value: 1, ifVersion: 6 }] })
      .catch((e: unknown) => e)) as SplatterVaultError;
    expect(err).toBeInstanceOf(SplatterVaultError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SplatterVaultError");
    expect(err.status).toBe(409);
    expect(err.code).toBe("version_conflict");
    expect(err.is("version_conflict")).toBe(true);
    expect(err.details).toEqual([{ store: "player", key: "coins", version: 7 }]);
    expect(err.requestId).toBe("0123456789abcdef0123456789abcdef");
    expect(err.retryAfter).toBeNull();
    expect(err.message).toBe("version_conflict (HTTP 409): The data changed since you read it.");
    expect(err.operationId).toBe("studioData.updatePlayerData");
    expect(err.method).toBe("PATCH");
    expect(err.path).toBe(`/studio-data/games/1/players/${PLAYER}/data`);
    expect(err.isTransient).toBe(false);
    expect(err.attempts).toBe(1);
  });

  it("maps the session routes' { name, message, status, errors }: no code, errorName set", async () => {
    const { fetch } = mockFetch({
      status: 400,
      body: { name: "BAD_REQUEST", message: "Insufficient credits", status: 400, errors: [{ path: "region" }] }
    });
    const err = (await sv(fetch).sessions.create({}).catch((e: unknown) => e)) as SplatterVaultError;
    expect(err.code).toBeNull();
    expect(err.errorName).toBe("BAD_REQUEST");
    expect(err.errors).toEqual([{ path: "region" }]);
    expect(err.message).toBe("BAD_REQUEST (HTTP 400): Insufficient credits");
  });

  it("maps the session routes' platform ban to code banned", async () => {
    const { fetch } = mockFetch({ status: 403, body: { banned: true, type: "ip", scopes: ["FULL_PLATFORM"], reason: "Banned." } });
    const err = (await sv(fetch).sessions.list().catch((e: unknown) => e)) as SplatterVaultError;
    expect(err).toMatchObject({ status: 403, code: "banned", details: { type: "ip", scopes: ["FULL_PLATFORM"] } });
    expect(err.message).toBe("banned (HTTP 403): Banned.");
  });

  it("keeps an unknown code, and the status, for an open set of codes", async () => {
    const { fetch } = mockFetch({ status: 418, body: { error: "brand_new_code", message: "Something new." } });
    const err = (await sv(fetch).store.getCatalog().catch((e: unknown) => e)) as SplatterVaultError;
    expect(err).toMatchObject({ status: 418, code: "brand_new_code" });
  });

  it("never quotes a non-JSON error page into the message", async () => {
    const { fetch } = mockFetch({ status: 404, text: "<html><body>nginx secret page</body></html>" });
    const err = (await sv(fetch, { maxRetries: 0 }).store.getCatalog().catch((e: unknown) => e)) as SplatterVaultError;
    expect(err.status).toBe(404);
    expect(err.code).toBeNull();
    expect(err.body).toBeUndefined();
    expect(err.message).toBe("HTTP 404 (HTTP 404): SplatterVault answered HTTP 404");
    expect(err.message).not.toContain("nginx");
  });

  it("a 2xx that is not JSON is invalid_response with its status", async () => {
    const { fetch } = mockFetch({ status: 200, text: "<html>captive portal</html>" });
    const err = (await sv(fetch).billing.getUsage().catch((e: unknown) => e)) as SplatterVaultError;
    expect(err).toMatchObject({ status: 200, code: "invalid_response" });
  });

  it("204 and empty 200 answers resolve to undefined", async () => {
    expect(await sv(mockFetch({ status: 204 }).fetch).players.erase(PLAYER)).toBeUndefined();
    expect(await sv(mockFetch({ status: 200, text: "" }).fetch).playerData.clear(1, PLAYER)).toBeUndefined();
  });

  it("a network failure is network_error, status 0, with the cause", async () => {
    const cause = new TypeError("fetch failed");
    const { fetch } = mockFetch(cause);
    const err = (await sv(fetch).sessions.create({}).catch((e: unknown) => e)) as SplatterVaultError;
    expect(err).toMatchObject({ status: 0, code: "network_error", isNetworkError: true, isTransient: true, attempts: 1 });
    expect(err.cause).toBe(cause);
  });

  it("reads both error body shapes", () => {
    expect(readErrorBody({ error: "x", message: "m", details: null })).toMatchObject({ code: "x", message: "m", details: undefined });
    expect(readErrorBody("text")).toMatchObject({ code: null, message: null });
    expect(readErrorBody([1])).toMatchObject({ code: null });
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("5")).toBe(5);
    expect(parseRetryAfter(" 60 ")).toBe(60);
    expect(parseRetryAfter("999999999")).toBe(86400);
    expect(parseRetryAfter("Sun, 15 Nov 2026 01:00:10 GMT", Date.parse("2026-11-15T01:00:00Z"))).toBe(10);
    expect(parseRetryAfter("Sun, 15 Nov 2026 00:59:00 GMT", Date.parse("2026-11-15T01:00:00Z"))).toBe(0);
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter("-1")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
  });
});

describe("timeouts and aborts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out an attempt after timeoutMs (code timeout) and retries a safe call", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fetch, calls } = hangingFetch();
    const p = sv(fetch, { timeoutMs: 1000, maxRetries: 1, retry: { baseDelayMs: 10, maxDelayMs: 10 } }).billing.getUsage();
    const settled = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls[0]!.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    const err = (await settled) as SplatterVaultError;
    expect(err).toMatchObject({ status: 0, code: "timeout", isNetworkError: true, attempts: 2 });
  });

  it("a per-call timeoutMs wins over the client's and an operation's", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fetch } = hangingFetch();
    const settled = sv(fetch, { timeoutMs: 60_000 }).sessions.create({}, { timeoutMs: 50 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(50);
    expect(await settled).toMatchObject({ code: "timeout", attempts: 1 });
  });

  it("slow operations get at least their own default timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fetch, calls } = hangingFetch();
    const settled = sv(fetch, { timeoutMs: 1000 }).sessions.create({}).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls[0]!.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toMatchObject({ code: "timeout" });
  });

  it("an abort from the caller's signal stops the call (code aborted), and is never retried", async () => {
    const { fetch, calls } = hangingFetch();
    const controller = new AbortController();
    const settled = sv(fetch).billing.getUsage({ signal: controller.signal }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort(new Error("shutting down"));
    const err = (await settled) as SplatterVaultError;
    expect(err).toMatchObject({ status: 0, code: "aborted" });
    expect((err.cause as Error).message).toBe("shutting down");
    expect(calls).toHaveLength(1);
  });

  it("an abort during the wait between retries ends the call at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fetch, calls } = mockFetch({ status: 503, body: { error: "data_busy", message: "m" }, headers: { "Retry-After": "5" } });
    const controller = new AbortController();
    const settled = sv(fetch).playerData.getGameData(1, undefined, { signal: controller.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    expect(await settled).toMatchObject({ code: "aborted", attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  it("an already aborted signal sends nothing", async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: {} });
    await expect(sv(fetch).billing.getUsage({ signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "aborted", attempts: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe("the client", () => {
  it("needs an API key, from options or SV_API_KEY", () => {
    const old = process.env.SV_API_KEY;
    try {
      delete process.env.SV_API_KEY;
      expect(() => new SplatterVault({ fetch: mockFetch({}).fetch })).toThrow(/apiKey is required/);
      // The old name is not read (no fallback): SV_API_KEY is the one variable.
      process.env.SV_ORG_API_KEY = "sv_org_old_name";
      try {
        expect(() => new SplatterVault({ fetch: mockFetch({}).fetch })).toThrow(/set SV_API_KEY/);
      } finally {
        delete process.env.SV_ORG_API_KEY;
      }
      expect(() => new SplatterVault({ apiKey: "" })).toThrow(/apiKey is required/);
      expect(() => new SplatterVault({ apiKey: "sv_org_abc\n" })).toThrow(/visible ASCII/);
      process.env.SV_API_KEY = "sv_org_from_env";
      expect(new SplatterVault({ fetch: mockFetch({}).fetch }).baseUrl).toBe("https://splattervault.com/rest");
    } finally {
      if (old === undefined) delete process.env.SV_API_KEY;
      else process.env.SV_API_KEY = old;
    }
  });

  it("sends the key from SV_API_KEY", async () => {
    const old = process.env.SV_API_KEY;
    process.env.SV_API_KEY = "sv_org_from_env";
    try {
      const { fetch, calls } = mockFetch({ status: 200, body: {} });
      await new SplatterVault({ baseUrl: BASE, fetch }).billing.getUsage();
      expect(calls[0]!.headers["x-api-key"]).toBe("sv_org_from_env");
    } finally {
      if (old === undefined) delete process.env.SV_API_KEY;
      else process.env.SV_API_KEY = old;
    }
  });

  it("refuses a bad baseUrl or timeout", () => {
    expect(() => new SplatterVault({ apiKey: KEY, baseUrl: "splattervault.com" })).toThrow(/baseUrl/);
    expect(() => new SplatterVault({ apiKey: KEY, timeoutMs: 0 })).toThrow(/timeoutMs/);
  });

  it("never shows its API key when logged or serialized", () => {
    const client = new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch: mockFetch({}).fetch });
    expect(inspect(client, { depth: 10, showHidden: true })).not.toContain(KEY);
    expect(JSON.stringify(client)).not.toContain(KEY);
    expect(inspect(client.store, { depth: 10, showHidden: true })).not.toContain(KEY);
    expect(JSON.stringify(client.store)).not.toContain(KEY);
    expect(String(client)).not.toContain(KEY);
  });

  it("never puts the API key in an error", async () => {
    const { fetch } = mockFetch({ status: 401, body: { error: "unauthorized", message: "Invalid, expired, or revoked organization API key" } });
    const err = await sv(fetch).store.getCatalog().catch((e: unknown) => e);
    expect(inspect(err, { depth: 10, showHidden: true })).not.toContain(KEY);
    expect(JSON.stringify(err)).not.toContain(KEY);
  });

  it("refuses to start in a browser-like environment unless dangerouslyAllowBrowser", () => {
    const g = globalThis as Record<string, unknown>;
    g.window = { document: {} };
    try {
      expect(() => new SplatterVault({ apiKey: KEY, fetch: mockFetch({}).fetch })).toThrow(/browser-like/);
      expect(() => new SplatterVault({ apiKey: KEY, fetch: mockFetch({}).fetch, dangerouslyAllowBrowser: true })).not.toThrow();
    } finally {
      delete g.window;
    }
    const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { product: "ReactNative" }, configurable: true });
    try {
      expect(() => new SplatterVault({ apiKey: KEY, fetch: mockFetch({}).fetch })).toThrow(/browser-like/);
    } finally {
      if (nav) Object.defineProperty(globalThis, "navigator", nav);
      else delete (globalThis as Record<string, unknown>).navigator;
    }
    g.importScripts = () => undefined;
    try {
      expect(() => new SplatterVault({ apiKey: KEY, fetch: mockFetch({}).fetch })).toThrow(/browser-like/);
    } finally {
      delete g.importScripts;
    }
    expect(() => new SplatterVault({ apiKey: KEY, fetch: mockFetch({}).fetch })).not.toThrow();
  });

  it("SDK_VERSION is package.json's version", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
