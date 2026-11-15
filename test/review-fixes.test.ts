// Regression tests for the 2026-11-15 independent review (FINDINGS.md: H1, H2, M1-M3, L1-L8) and the cross-SDK rules
// (DECISIONS.md 1, 2, 3, 5, 6). Each one failed on 0.1.0 as first built.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { recordWin, sellBack } from "../examples/rewards.js";
import { createPlayerTokenVerifier, PlayerTokenError, SplatterVault, SplatterVaultError, verifyPlayerToken } from "../src/index.js";
import { BASE, KEY, mockFetch, type Reply, type Step } from "./helpers/mockFetch.js";
import { makeKey, signToken } from "./helpers/playerTokens.js";

const PLAYER = "8f14e45f-ceea-467f-a8f1-2a0e3f5b1c9d";
const txn = { txn: { id: "t" }, changes: [], balances: [], items: [], shortfall: [], replayed: false };
const studioErr = (status: number, error: string, headers?: Record<string, string>): Reply => ({ status, body: { error, message: `${error}.` }, headers });
const fast = { retry: { baseDelayMs: 1, maxDelayMs: 2 } };
const sv = (fetch: ReturnType<typeof mockFetch>["fetch"], extra: Partial<ConstructorParameters<typeof SplatterVault>[0]> = {}) =>
  new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch, ...fast, ...extra });
const caught = (p: Promise<unknown>) => p.then(() => Promise.reject(new Error("expected a rejection")), (e: unknown) => e as SplatterVaultError);
const conditionalSet = { ops: [{ op: "set" as const, store: "player" as const, key: "k", value: 1, ifVersion: 3 }] };

describe("H1 / rule 2: ifVersion writes are never re-sent after an unknown outcome", () => {
  it("a timeout, a network error, 500, 502 and 504 are not re-sent: outcomeUnknown", async () => {
    for (const first of [new TypeError("socket hang up"), studioErr(500, "internal_error"), { status: 502 }, { status: 504 }] as Step[]) {
      const { fetch, calls } = mockFetch(first, { status: 200, body: { results: [] } });
      const err = await caught(sv(fetch).playerData.update(1, PLAYER, conditionalSet));
      expect(err).toBeInstanceOf(SplatterVaultError);
      expect({ outcomeUnknown: err.outcomeUnknown, attempts: err.attempts }).toEqual({ outcomeUnknown: true, attempts: 1 });
      expect(calls).toHaveLength(1);
    }
    const timeoutFetch = mockFetch((req) => new Promise<Reply>((_r, reject) => req.signal?.addEventListener("abort", () => reject(req.signal?.reason))));
    const err = await caught(sv(timeoutFetch.fetch, { timeoutMs: 20 }).playerData.writeMany(1, { writes: [{ player: PLAYER, ...conditionalSet }] }));
    expect(err).toMatchObject({ code: "timeout", outcomeUnknown: true, attempts: 1 });
    expect(timeoutFetch.calls).toHaveLength(1);
  });

  it("408, 429 and 503 (nothing applied) are re-sent", async () => {
    for (const first of [studioErr(408, "timeout"), studioErr(429, "rate_limited", { "Retry-After": "0" }), studioErr(503, "data_busy")]) {
      const { fetch, calls } = mockFetch(first, { status: 200, body: { results: [] } });
      await expect(sv(fetch).playerData.updateGameData(1, { ops: [{ op: "delete", store: "public", key: "k", ifVersion: 2 }] })).resolves.toEqual({ results: [] });
      expect(calls).toHaveLength(2);
    }
  });

  it("a re-sent write that meets version_conflict is outcome_unknown, never a plain conflict", async () => {
    const { fetch, calls } = mockFetch(studioErr(503, "data_busy"), {
      status: 409,
      body: { error: "version_conflict", message: "changed", details: [{ store: "player", key: "k", version: 4 }] }
    });
    const err = await caught(sv(fetch).playerData.update(1, PLAYER, conditionalSet));
    expect(err).toMatchObject({ status: 409, code: "outcome_unknown", outcomeUnknown: true, attempts: 2 });
    expect(err.details).toEqual([{ store: "player", key: "k", version: 4 }]);
    expect((err.body as { error: string }).error).toBe("version_conflict");
    expect(calls).toHaveLength(2);
  });

  it("a first-send version_conflict stays a plain conflict", async () => {
    const { fetch } = mockFetch(studioErr(409, "version_conflict"));
    await expect(sv(fetch).playerData.update(1, PLAYER, conditionalSet)).rejects.toMatchObject({ code: "version_conflict", outcomeUnknown: false });
  });

  it("examples/rewards.ts recordWin counts ONE win when the first write's answer is lost (the reviewer's probe2)", async () => {
    let stored: { value: unknown; version: number } | null = null;
    let seq = 0;
    let applied = 0;
    const fetch = mockFetch(async (req) => {
      if (req.method === "GET") {
        return { status: 200, body: { data: { readonly: stored ? { stats: { ...stored, sizeBytes: 1, updatedAt: null, updatedBy: "studio" } } : {} } } };
      }
      const op = (req.body as { ops: { value: unknown; ifVersion: number }[] }).ops[0]!;
      const holds = op.ifVersion === 0 ? stored === null : stored?.version === op.ifVersion;
      if (!holds) return studioErr(409, "version_conflict");
      stored = { value: op.value, version: ++seq };
      applied++;
      if (applied === 1) {
        // Applied, but the answer never arrives in time.
        await new Promise((_r, reject) => req.signal?.addEventListener("abort", () => reject(req.signal?.reason)));
      }
      return { status: 200, body: { results: [{ store: "readonly", key: "stats", version: seq }] } };
    });
    await recordWin(sv(fetch.fetch, { timeoutMs: 50 }), PLAYER, "m-1");
    expect(applied).toBe(1);
    expect((stored as { value: { wins: number } } | null)?.value.wins).toBe(1);
  });
});

describe("rule 1: 408 and 500 are transient", () => {
  it("a read is retried after 408 and after 500", async () => {
    const { fetch, calls } = mockFetch(studioErr(408, "timeout"), studioErr(500, "internal_error"), { status: 200, body: { balance: 1 } });
    await expect(sv(fetch).billing.getCredits()).resolves.toEqual({ balance: 1 });
    expect(calls).toHaveLength(3);
  });

  it("a store change is retried after 500 with the same key and body", async () => {
    const { fetch, calls } = mockFetch(studioErr(500, "internal_error"), { status: 200, body: { ...txn, replayed: true } });
    await sv(fetch).store.grant(PLAYER, { lines: [{ currency: "GOLD", amount: 1 }] });
    expect(new Set(calls.map((c) => `${c.headers["idempotency-key"]}|${c.rawBody}`)).size).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("isTransient covers 408, 429, 500, 502, 503, 504", () => {
    const at = (status: number) => new SplatterVaultError({ status, code: null, message: "", operationId: "o", method: "GET", path: "/" }).isTransient;
    expect([408, 429, 500, 502, 503, 504].map(at)).toEqual([true, true, true, true, true, true]);
    expect([400, 401, 403, 404, 409, 422, 301].map(at)).toEqual([false, false, false, false, false, false, false]);
  });
});

describe("H2 / rule 5: no redirects, no plain http", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });
  const listen = (handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void) =>
    new Promise<number>((resolve) => {
      const server = createServer(handler);
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });

  it("asks fetch not to follow redirects, and a 3xx is a non-retried error naming its location", async () => {
    const { fetch, calls } = mockFetch({ status: 302, headers: { location: "https://elsewhere.test/rest/credits" } });
    const err = await caught(sv(fetch).billing.getCredits());
    expect(calls[0]!.redirect).toBe("manual");
    expect(err).toMatchObject({ status: 302, code: "redirect_not_followed", attempts: 1, details: { location: "https://elsewhere.test/rest/credits" } });
    expect(calls).toHaveLength(1);
  });

  it("over real HTTP, the API key never reaches the redirect target and a create is never turned into a list (probe3)", async () => {
    const seen: string[] = [];
    const target = await listen((req, res) => {
      seen.push(`${req.method} ${req.url} key=${req.headers["x-api-key"] ? "yes" : "no"}`);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ id: 1, status: "Active" }]));
    });
    const redirector = await listen((req, res) => {
      res.statusCode = 301;
      res.setHeader("location", `http://localhost:${target}${req.url}`);
      res.end();
    });
    const client = new SplatterVault({ apiKey: KEY, baseUrl: `http://127.0.0.1:${redirector}/rest` });
    await expect(client.sessions.create({ gameTypeConfigKey: "g" })).rejects.toMatchObject({ status: 301, code: "redirect_not_followed" });
    await expect(client.billing.getCredits()).rejects.toMatchObject({ status: 301, code: "redirect_not_followed", attempts: 1 });
    expect(seen).toEqual([]);
  });

  it("refuses plain http except loopback, credentials, a query or a fragment", () => {
    const make = (baseUrl: string, extra = {}) => () => new SplatterVault({ apiKey: KEY, baseUrl, fetch: mockFetch({}).fetch, ...extra });
    expect(make("http://splattervault.com/rest")).toThrow(/must use https/);
    expect(make("http://10.0.0.5:3000/rest")).toThrow(/must use https/);
    expect(make("http://10.0.0.5:3000/rest", { dangerouslyAllowInsecureHttp: true })).not.toThrow();
    for (const ok of ["http://localhost:8790/rest", "http://127.0.0.1:8790/rest", "http://[::1]:8790/rest", "https://api.test/rest"]) expect(make(ok)).not.toThrow();
    expect(make("https://user:pw@api.test/rest")).toThrow(/user name or password/);
    expect(make("https://api.test/rest?x=1")).toThrow(/query/);
    expect(make("https://api.test/rest#x")).toThrow(/fragment/);
    expect(make("ftp://api.test/rest")).toThrow(/https URL/);
  });

  it("the verifier refuses plain-http key URLs (planted keys) and never follows a redirect for the keys", async () => {
    expect(() => createPlayerTokenVerifier({ gameId: 42, baseUrl: "http://keys.example.com/rest" })).toThrow(/must use https/);
    expect(() => createPlayerTokenVerifier({ gameId: 42, jwksUrl: "http://keys.example.com/keys" })).toThrow(/must use https/);
    expect(() => verifyPlayerToken("x", { gameId: 42, jwksUrl: "http://keys.example.com/keys" })).toThrow(/must use https/);
    expect(() => createPlayerTokenVerifier({ gameId: 42, jwksUrl: "http://keys.example.com/keys", dangerouslyAllowInsecureHttp: true })).not.toThrow();

    const key = makeKey();
    const { fetch, calls } = mockFetch({ status: 302, headers: { location: "https://evil.test/keys" } });
    const v = createPlayerTokenVerifier({ gameId: 42, baseUrl: BASE, fetch });
    const err = await v.verify(signToken(key, Math.floor(Date.now() / 1000))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlayerTokenError);
    expect(err).toMatchObject({ code: "keys_unavailable" });
    expect(calls[0]!.redirect).toBe("manual");
  });
});

describe("M1 / rule 6: verifier options are validated", () => {
  it("NaN, Infinity and out-of-range values throw at construction", () => {
    const keys = { keys: [makeKey().jwk] };
    const bad: Record<string, unknown>[] = [
      { clockToleranceSeconds: Number.NaN },
      { clockToleranceSeconds: Infinity },
      { clockToleranceSeconds: -1 },
      { clockToleranceSeconds: 301 },
      { maxLifetimeSeconds: Number.NaN },
      { maxLifetimeSeconds: 0 },
      { maxLifetimeSeconds: 3601 },
      { timeoutMs: 2 ** 31 },
      { timeoutMs: 0 },
      { minRefetchIntervalMs: -5 },
      { staleIfErrorSeconds: Number.NaN },
      { staleIfErrorSeconds: 3601 },
      { now: 5 }
    ];
    for (const options of bad) expect(() => createPlayerTokenVerifier({ gameId: 42, keys, ...options }), JSON.stringify(options)).toThrow();
  });

  it("a 30-day-old token is refused (the reviewer's probe1 #5 accepted it with a NaN tolerance)", async () => {
    const key = makeKey();
    const old = Math.floor(Date.now() / 1000) - 30 * 86400;
    const v = createPlayerTokenVerifier({ gameId: 42, keys: { keys: [key.jwk] }, clockToleranceSeconds: 0 });
    await expect(v.verify(signToken(key, old))).rejects.toMatchObject({ code: "token_expired" });
  });
});

describe("M2: the key set is not fetched per verification", () => {
  it("no-store and max-age=0 are kept for at least 60 s (100 verifications, 1 fetch)", async () => {
    for (const cc of ["no-store", "max-age=0"]) {
      const key = makeKey();
      let now = Date.parse("2026-11-15T01:00:00Z");
      const { fetch, calls } = mockFetch({ status: 200, body: { keys: [key.jwk] }, headers: { "cache-control": cc } });
      const v = createPlayerTokenVerifier({ gameId: 42, baseUrl: BASE, fetch, now: () => now });
      const token = signToken(key, Math.floor(now / 1000));
      for (let i = 0; i < 100; i++) await v.verify(token);
      expect(calls).toHaveLength(1);
      now += 60_000;
      await v.verify(token);
      expect(calls).toHaveLength(2);
    }
  });

  it("a key set is kept at most an hour, whatever max-age says", async () => {
    const key = makeKey();
    let now = Date.parse("2026-11-15T01:00:00Z");
    const { fetch, calls } = mockFetch({ status: 200, body: { keys: [key.jwk] }, headers: { "cache-control": "max-age=31536000" } });
    const v = createPlayerTokenVerifier({ gameId: 42, baseUrl: BASE, fetch, now: () => now });
    await v.verify(signToken(key, Math.floor(now / 1000)));
    now += 3_600_000;
    await v.verify(signToken(key, Math.floor(now / 1000)));
    expect(calls).toHaveLength(2);
  });

  it("with the API down and nothing cached, a failed fetch is not repeated for minRefetchIntervalMs (probe1 #6b)", async () => {
    let now = Date.parse("2026-11-15T01:00:00Z");
    const { fetch, calls } = mockFetch(new TypeError("fetch failed"));
    const v = createPlayerTokenVerifier({ gameId: 42, baseUrl: BASE, fetch, now: () => now });
    const token = signToken(makeKey(), Math.floor(now / 1000));
    for (let i = 0; i < 100; i++) await expect(v.verify(token)).rejects.toMatchObject({ code: "keys_unavailable" });
    expect(calls).toHaveLength(1);
    now += 10_000;
    await expect(v.verify(token)).rejects.toMatchObject({ code: "keys_unavailable" });
    expect(calls).toHaveLength(2);
  });
});

describe("M3: the release workflow", () => {
  const text = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const jobs = Object.fromEntries(
    text
      .slice(text.indexOf("\njobs:\n"))
      .split(/\n(?= {2}[a-z][\w-]*:\n)/)
      .slice(1)
      .map((block) => [block.trim().split(":")[0]!, block])
  );

  it("grants no rights by default and id-token only to the publish job", () => {
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(Object.keys(jobs).sort()).toEqual(["build", "publish", "release"]);
    for (const [name, block] of Object.entries(jobs)) expect({ name, idToken: block.includes("id-token: write") }).toEqual({ name, idToken: name === "publish" });
    expect(jobs.publish).not.toMatch(/contents: write/);
  });

  it("the publish job runs no project scripts and publishes the built tarball", () => {
    expect(jobs.publish).not.toMatch(/npm (ci|run|test)\b|npm install(?! -g npm@)/);
    expect(jobs.publish).not.toMatch(/actions\/checkout/);
    expect(jobs.publish).toMatch(/npm publish "\.\/\$TARBALL" --provenance .*--ignore-scripts/);
    expect(jobs.publish).toMatch(/environment: npm/);
  });

  it("checkouts keep no credentials and every action is pinned by commit SHA", () => {
    for (const file of [text, ci]) {
      const uses = file.match(/uses: \S+/g) ?? [];
      expect(uses.length).toBeGreaterThan(0);
      for (const u of uses) expect(u).toMatch(/^uses: [\w-]+\/[\w-]+@[0-9a-f]{40}$/);
      const checkouts = file.split("actions/checkout@").length - 1;
      expect(file.split("persist-credentials: false").length - 1).toBe(checkouts);
    }
  });
});

describe("L1 / rule 6: client and call options are validated", () => {
  it("throws at construction for NaN, Infinity or out-of-range numbers", () => {
    const make = (extra: object) => () => new SplatterVault({ apiKey: KEY, fetch: mockFetch({}).fetch, ...extra });
    for (const extra of [
      { maxRetries: Number.NaN },
      { maxRetries: -1 },
      { maxRetries: 1.5 },
      { maxRetries: Infinity },
      { timeoutMs: 2 ** 31 },
      { timeoutMs: Infinity },
      { timeoutMs: Number.NaN },
      { retry: { maxRetryAfterMs: Number.NaN } },
      { retry: { baseDelayMs: -1 } },
      { retry: { maxDelayMs: 2 ** 31 } }
    ]) {
      expect(make(extra), JSON.stringify(extra)).toThrow(RangeError);
    }
    expect(make({ timeoutMs: 2 ** 31 - 1, maxRetries: 20 })).not.toThrow();
  });

  it("a call's NaN maxRetries or oversized timeout is refused before sending", async () => {
    const { fetch, calls } = mockFetch({ status: 503 });
    const client = sv(fetch);
    await expect(client.billing.getCredits({ maxRetries: Number.NaN })).rejects.toThrow(RangeError);
    await expect(client.billing.getCredits({ timeoutMs: 2 ** 31 })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe("L2: dot segments in path parameters", () => {
  it("'.' and '..' are refused before sending (probe1 #7)", async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: {} });
    const client = sv(fetch);
    await expect(client.store.getPlayer("..")).rejects.toThrow(/must not be/);
    await expect(client.store.grant("..", { lines: [{ currency: "GOLD", amount: 1 }] })).rejects.toThrow(TypeError);
    await expect(client.playerData.clear(42, "..")).rejects.toThrow(TypeError);
    await expect(client.players.erase(".")).rejects.toThrow(TypeError);
    await expect(client.store.updateItem(PLAYER, "..", { custom: null })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
    // Dots inside a value are fine (they are not a whole segment).
    await client.store.getPlayer("studio:a..b");
    expect(calls[0]!.url).toBe(`${BASE}/store/studio/players/studio%3Aa..b`);
  });
});

describe("L3: empty store or key lists", () => {
  it("are refused instead of reading everything", async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: {} });
    const client = sv(fetch);
    await expect(client.playerData.get(42, PLAYER, { keys: [] })).rejects.toThrow(/keys must not be empty/);
    await expect(client.playerData.get(42, PLAYER, { stores: [] })).rejects.toThrow(/stores must not be empty/);
    await expect(client.playerData.getGameData(42, { keys: [] })).rejects.toThrow(TypeError);
    await expect(client.playerData.getMany(42, { players: [PLAYER], keys: [] })).rejects.toThrow(TypeError);
    await expect(client.playerData.getMany(42, { players: [PLAYER], stores: [] })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe("L4 / rule 3: the Idempotency-Key is on the error", () => {
  it("auto and caller keys are exposed, with outcomeUnknown after a lost answer", async () => {
    const auto = mockFetch(new TypeError("socket hang up"));
    const err = await caught(sv(auto.fetch, { maxRetries: 1 }).store.purchase(PLAYER, { sku: "s", currency: "GOLD" }));
    expect(err.idempotencyKey).toBe(auto.calls[0]!.headers["idempotency-key"]);
    expect(err.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(err.outcomeUnknown).toBe(true);

    const mine = mockFetch(studioErr(409, "insufficient_funds"));
    const err2 = await caught(sv(mine.fetch).store.purchase(PLAYER, { sku: "s", currency: "GOLD" }, { idempotencyKey: "buy:1" }));
    expect(err2).toMatchObject({ idempotencyKey: "buy:1", outcomeUnknown: false, code: "insufficient_funds" });

    const other = mockFetch(studioErr(404, "player_not_found"));
    expect(await caught(sv(other.fetch).store.getPlayer(PLAYER))).toMatchObject({ idempotencyKey: null, outcomeUnknown: false });
  });

  it("resending with err.idempotencyKey settles an unknown outcome exactly once", async () => {
    const applied = new Set<string>();
    const { fetch } = mockFetch(new TypeError("down"), new TypeError("down"), new TypeError("down"), (req) => {
      const key = req.headers["idempotency-key"]!;
      const replayed = applied.has(key);
      applied.add(key);
      return { status: replayed ? 200 : 201, body: { ...txn, replayed } };
    });
    const client = sv(fetch);
    const err = await caught(client.store.grant(PLAYER, { lines: [{ currency: "GOLD", amount: 5 }] }));
    expect(err.outcomeUnknown).toBe(true);
    const again = await client.store.grant(PLAYER, { lines: [{ currency: "GOLD", amount: 5 }] }, { idempotencyKey: err.idempotencyKey! });
    expect(again.replayed).toBe(false);
    expect(applied.size).toBe(1);
  });

  it("a resent change meeting idempotency_conflict (its own first send in progress) is retried; a first one is not", async () => {
    const resent = mockFetch(studioErr(503, "x"), studioErr(409, "idempotency_conflict"), { status: 200, body: { ...txn, replayed: true } });
    await expect(sv(resent.fetch).store.grant(PLAYER, { lines: [{ currency: "GOLD", amount: 1 }] })).resolves.toMatchObject({ replayed: true });
    expect(resent.calls).toHaveLength(3);

    const first = mockFetch(studioErr(409, "idempotency_conflict"));
    await expect(sv(first.fetch).store.grant(PLAYER, { lines: [{ currency: "GOLD", amount: 1 }] }, { idempotencyKey: "used" })).rejects.toMatchObject({
      code: "idempotency_conflict",
      attempts: 1,
      outcomeUnknown: false
    });
  });
});

describe("outcomeUnknown on other writes", () => {
  it("is true for a session create without an answer, false for reads and for clear refusals", async () => {
    expect(await caught(sv(mockFetch(new TypeError("x")).fetch).sessions.create({}))).toMatchObject({ outcomeUnknown: true, attempts: 1 });
    expect(await caught(sv(mockFetch({ status: 502 }).fetch).serverPools.claim(1))).toMatchObject({ outcomeUnknown: true });
    expect(await caught(sv(mockFetch({ status: 400, body: { name: "BAD_REQUEST", message: "m" } }).fetch).sessions.create({}))).toMatchObject({
      outcomeUnknown: false
    });
    expect(await caught(sv(mockFetch(new TypeError("x")).fetch, { maxRetries: 0 }).billing.getUsage())).toMatchObject({ outcomeUnknown: false });
    expect(await caught(sv(mockFetch(new TypeError("x")).fetch, { maxRetries: 0 }).playerData.resolve(1, { refs: [PLAYER] }))).toMatchObject({
      outcomeUnknown: false
    });
  });
});

describe("L5: offline-verification limits and the stale window", () => {
  it("an expired key set serves 300 s by default while fetching fails, then not", async () => {
    const key = makeKey();
    let now = Date.parse("2026-11-15T01:00:00Z");
    const { fetch } = mockFetch({ status: 200, body: { keys: [key.jwk] }, headers: { "cache-control": "max-age=300" } }, new TypeError("down"));
    const v = createPlayerTokenVerifier({ gameId: 42, baseUrl: BASE, fetch, now: () => now });
    await v.verify(signToken(key, Math.floor(now / 1000)));
    now += 300_000 + 299_000;
    await expect(v.verify(signToken(key, Math.floor(now / 1000)))).resolves.toBeTruthy();
    now += 2_000;
    await expect(v.verify(signToken(key, Math.floor(now / 1000)))).rejects.toMatchObject({ code: "keys_unavailable" });
  });

  it("the docs say what offline verification cannot see", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const source = readFileSync(new URL("../src/playerToken/verify.ts", import.meta.url), "utf8");
    for (const text of [readme, source]) {
      expect(text).toMatch(/player_deleted/);
      expect(text).toMatch(/another owner/);
    }
    expect(readme).toMatch(/staleIfErrorSeconds` \(default 300\)/);
  });
});

describe("L6: Electron and NW.js", () => {
  it("refuses to start in an Electron or NW.js process unless dangerouslyAllowBrowser", () => {
    for (const name of ["electron", "nw"]) {
      Object.defineProperty(process.versions, name, { value: "30.0.0", configurable: true });
      try {
        expect(() => new SplatterVault({ apiKey: KEY, fetch: mockFetch({}).fetch })).toThrow(/browser-like/);
        expect(() => new SplatterVault({ apiKey: KEY, fetch: mockFetch({}).fetch, dangerouslyAllowBrowser: true })).not.toThrow();
      } finally {
        Reflect.deleteProperty(process.versions, name);
      }
    }
    expect(() => new SplatterVault({ apiKey: KEY, fetch: mockFetch({}).fetch })).not.toThrow();
  });
});

describe("L8: examples/rewards.ts sellBack", () => {
  it("is two changes with fixed keys, so running it again replays instead of paying twice; its comment says so", async () => {
    const seen = new Map<string, number>();
    const { fetch, calls } = mockFetch((req) => {
      const key = req.headers["idempotency-key"]!;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      return { status: seen.get(key)! > 1 ? 200 : 201, body: { ...txn, replayed: seen.get(key)! > 1 } };
    });
    await sellBack(sv(fetch), PLAYER, "0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b");
    await sellBack(sv(fetch), PLAYER, "0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b");
    expect(calls.map((c) => c.headers["idempotency-key"])).toEqual([
      "sell:0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b",
      "sell-pay:0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b",
      "sell:0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b",
      "sell-pay:0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b"
    ]);
    const example = readFileSync(new URL("../examples/rewards.ts", import.meta.url), "utf8");
    expect(example).not.toMatch(/in one change, or neither/);
    expect(example).toMatch(/NOT one atomic change/);
  });
});
