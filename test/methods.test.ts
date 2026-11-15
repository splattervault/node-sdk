import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { OPERATIONS, SplatterVault } from "../src/index.js";
import { BASE, KEY, mockFetch, type Reply } from "./helpers/mockFetch.js";
import { SURFACE } from "./surface.js";

const spec = JSON.parse(readFileSync(new URL("../openapi/studio-api.json", import.meta.url), "utf8")) as {
  paths: Record<string, Record<string, { operationId?: string }>>;
};

const PLAYER = "8f14e45f-ceea-467f-a8f1-2a0e3f5b1c9d";
const INSTANCE = "0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b";
const session = { id: 4211, status: "Pending", code: "ABCD", region: "NYC3", connection: null };
const txnResult = {
  txn: { id: "a6b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d", kind: "grant", createdAt: "2026-11-15T01:00:00.000Z", reason: null, reverses: null },
  changes: [{ currency: "GOLD", delta: 500, after: 1500 }],
  balances: [{ currency: "GOLD", amount: 1500 }],
  items: [],
  shortfall: [],
  replayed: false
};
const report = { importId: "c0ffee00-0000-4000-8000-000000000001", dryRun: true, counts: { rows: 1, created: 1, updated: 0, unchanged: 0, conflict: 0, invalid: 0 }, results: [{ line: 1, status: "created" }] };
const dataEntry = { value: 10, version: 3, sizeBytes: 2, updatedAt: "2026-11-15T01:00:00.000Z", updatedBy: "studio" };

interface Case {
  method: keyof typeof SURFACE;
  call: (sv: SplatterVault) => Promise<unknown>;
  http: string;
  /** Expected URL after the base URL. */
  url: string;
  body?: unknown;
  idempotencyKey?: string | "auto";
  reply: Reply;
}

const ok = (body: unknown, status = 200): Reply => ({ status, body });

const CASES: Case[] = [
  // ── sessions ──
  {
    method: "sessions.create",
    call: (sv) => sv.sessions.create({ gameTypeConfigKey: "my-game", region: "NYC3", friendlyName: "Match 7", idleTimeoutMinutes: 15 }),
    http: "POST",
    url: "/credits/sessions",
    body: { gameTypeConfigKey: "my-game", region: "NYC3", friendlyName: "Match 7", idleTimeoutMinutes: 15 },
    reply: ok(session, 201)
  },
  {
    method: "sessions.list",
    call: (sv) => sv.sessions.list({ organizationId: 7, status: "Active,Pending" }),
    http: "GET",
    url: "/credits/sessions?organizationId=7&status=Active%2CPending",
    reply: ok([session])
  },
  { method: "sessions.get", call: (sv) => sv.sessions.get(4211, { slim: true }), http: "GET", url: "/game-sessions/4211?slim=true", reply: ok(session) },
  {
    method: "sessions.listMine",
    call: (sv) => sv.sessions.listMine({ gameType: "PPG", status: "Active" }),
    http: "GET",
    url: "/game-sessions/my-sessions?gameType=PPG&status=Active",
    reply: ok([session])
  },
  {
    method: "sessions.stop",
    call: (sv) => sv.sessions.stop(4211),
    http: "POST",
    url: "/credits/sessions/4211/stop",
    reply: ok({ session: { ...session, status: "Not Active" }, totalHours: 0.5, totalCost: 0.67 })
  },
  {
    method: "sessions.rename",
    call: (sv) => sv.sessions.rename("4211", "Finals"),
    http: "PUT",
    url: "/credits/sessions/4211/friendly-name",
    body: { friendlyName: "Finals" },
    reply: ok({ ...session, friendlyName: "Finals" })
  },
  {
    method: "sessions.reschedule",
    call: (sv) => sv.sessions.reschedule(4211, { scheduledStartTime: "2026-11-16T18:00:00Z", scheduledEndTime: null }),
    http: "PUT",
    url: "/credits/sessions/4211/schedule",
    body: { scheduledStartTime: "2026-11-16T18:00:00Z", scheduledEndTime: null },
    reply: ok(session)
  },
  {
    method: "sessions.cancelSchedule",
    call: (sv) => sv.sessions.cancelSchedule(4211),
    http: "POST",
    url: "/credits/sessions/4211/cancel-schedule",
    reply: ok({ message: "Scheduled session canceled", session })
  },
  {
    method: "sessions.subscription.create",
    call: (sv) => sv.sessions.subscription.create({ gameTypeConfigKey: "my-game" }),
    http: "POST",
    url: "/subscriptions/sessions",
    body: { gameTypeConfigKey: "my-game" },
    reply: ok(session, 201)
  },
  {
    method: "sessions.subscription.list",
    call: (sv) => sv.sessions.subscription.list({ organizationId: 0 }),
    http: "GET",
    url: "/subscriptions/sessions?organizationId=0",
    reply: ok([])
  },
  { method: "sessions.subscription.stop", call: (sv) => sv.sessions.subscription.stop(9), http: "POST", url: "/subscriptions/sessions/9/stop", reply: ok(session) },
  {
    method: "sessions.subscription.rename",
    call: (sv) => sv.sessions.subscription.rename(9, "Scrim"),
    http: "PUT",
    url: "/subscriptions/sessions/9/friendly-name",
    body: { friendlyName: "Scrim" },
    reply: ok(session)
  },
  {
    method: "sessions.subscription.reschedule",
    call: (sv) => sv.sessions.subscription.reschedule(9, { scheduledEndTime: "2026-11-16T20:00:00Z" }),
    http: "PUT",
    url: "/subscriptions/sessions/9/schedule",
    body: { scheduledEndTime: "2026-11-16T20:00:00Z" },
    reply: ok(session)
  },
  {
    method: "sessions.subscription.cancelSchedule",
    call: (sv) => sv.sessions.subscription.cancelSchedule(9),
    http: "POST",
    url: "/subscriptions/sessions/9/cancel-schedule",
    reply: ok({ message: "ok", session })
  },
  {
    method: "serverPools.claim",
    call: (sv) => sv.serverPools.claim(12, { friendlyName: "Ranked #88", mode: "Ranked", ttlSeconds: 3600 }),
    http: "POST",
    url: "/server-pools/12/claim",
    body: { friendlyName: "Ranked #88", mode: "Ranked", ttlSeconds: 3600 },
    reply: ok({ sessionId: 4300, serverInstanceId: 77, connection: { host: "203.0.113.9", primaryPort: 7777, code: "QWER" } })
  },
  {
    method: "games.getConfigurableArgs",
    call: (sv) => sv.games.getConfigurableArgs("my game"),
    http: "GET",
    url: "/game-types/my%20game/configurable-args",
    reply: ok([{ flag: "-maxPlayers", type: "number", userConfigurable: true }])
  },
  // ── billing ──
  { method: "billing.getCredits", call: (sv) => sv.billing.getCredits(), http: "GET", url: "/credits", reply: ok({ id: 0, balance: 120.5 }) },
  {
    method: "billing.getCreditStats",
    call: (sv) => sv.billing.getCreditStats({ organizationId: 7 }),
    http: "GET",
    url: "/credits/stats?organizationId=7",
    reply: ok({ balance: 120.5, monthlyUsage: 3 })
  },
  {
    method: "billing.getOrgCredits",
    call: (sv) => sv.billing.getOrgCredits(),
    http: "GET",
    url: "/org/credits",
    reply: ok({ balance: 1, availableBalance: 1, subscriptionBalance: 0, adHocBalance: 1 })
  },
  {
    method: "billing.getOrgSubscriptions",
    call: (sv) => sv.billing.getOrgSubscriptions({ organizationId: 7 }),
    http: "GET",
    url: "/org/subscription?organizationId=7",
    reply: ok([{ id: 1, tier: "pro", status: "active" }])
  },
  {
    method: "billing.getOrgCreditsById",
    call: (sv) => sv.billing.getOrgCreditsById(7),
    http: "GET",
    url: "/organizations/7/credits",
    reply: ok({ balance: 1, availableBalance: 1, subscriptionBalance: 0, adHocBalance: 1 })
  },
  {
    method: "billing.getOrgSubscriptionById",
    call: (sv) => sv.billing.getOrgSubscriptionById(7),
    http: "GET",
    url: "/organizations/7/subscription",
    reply: ok({ current: null, all: [] })
  },
  {
    method: "billing.getSubscriptions",
    call: (sv) => sv.billing.getSubscriptions({ includeStripeHistory: false }),
    http: "GET",
    url: "/subscriptions?includeStripeHistory=false",
    reply: ok({ current: null, all: [] })
  },
  { method: "billing.getUsage", call: (sv) => sv.billing.getUsage(), http: "GET", url: "/subscriptions/usage", reply: ok({ currentInstances: 1 }) },
  // ── players ──
  {
    method: "players.signIn",
    call: (sv) => sv.players.signIn({ gameId: 42, externalId: "user-981", displayName: "Nova" }),
    http: "POST",
    url: "/player-auth/studio",
    body: { gameId: 42, externalId: "user-981", displayName: "Nova" },
    reply: ok({
      token: "eyJ.e30.sig",
      expiresAt: "2026-11-15T02:00:00.000Z",
      player: { id: PLAYER, displayName: "Nova", createdAt: "2026-11-15T01:00:00.000Z", newPlayer: true },
      identities: [{ provider: "studio", linkedAt: "2026-11-15T01:00:00.000Z" }]
    })
  },
  {
    method: "players.import",
    call: (sv) => sv.players.import({ gameId: 42, dryRun: true, rows: [{ identities: [{ provider: "steam", providerId: "76561198000000000" }] }] }),
    http: "POST",
    url: "/player-auth/studio/import",
    body: { gameId: 42, dryRun: true, rows: [{ identities: [{ provider: "steam", providerId: "76561198000000000" }] }] },
    reply: ok(report)
  },
  {
    method: "players.erase",
    call: (sv) => sv.players.erase(PLAYER),
    http: "DELETE",
    url: `/player-auth/studio/players/${PLAYER}`,
    reply: { status: 204 }
  },
  // ── player data ──
  {
    method: "playerData.resolve",
    call: (sv) => sv.playerData.resolve(42, { refs: [{ provider: "steam", providerId: "76561198000000000" }, PLAYER] }),
    http: "POST",
    url: "/studio-data/games/42/players/resolve",
    body: { refs: [{ provider: "steam", providerId: "76561198000000000" }, PLAYER] },
    reply: ok({ players: [{ index: 0, id: PLAYER }, { index: 1, id: PLAYER }] })
  },
  {
    method: "playerData.get",
    call: (sv) => sv.playerData.get(42, PLAYER, { stores: ["player", "readonly"], keys: ["coins", "level"], keysOnly: true }),
    http: "GET",
    url: `/studio-data/games/42/players/${PLAYER}/data?stores=player%2Creadonly&keys=coins%2Clevel&keysOnly=true`,
    reply: ok({ data: { player: { coins: dataEntry } } })
  },
  {
    method: "playerData.update",
    call: (sv) =>
      sv.playerData.update("42", PLAYER, {
        ops: [
          { op: "set", store: "player", key: "loadout", value: { gun: "pistol" }, ifVersion: 2 },
          { op: "inc", store: "readonly", key: "xp", by: 50, max: 10000 }
        ]
      }),
    http: "PATCH",
    url: `/studio-data/games/42/players/${PLAYER}/data`,
    body: {
      ops: [
        { op: "set", store: "player", key: "loadout", value: { gun: "pistol" }, ifVersion: 2 },
        { op: "inc", store: "readonly", key: "xp", by: 50, max: 10000 }
      ]
    },
    reply: ok({ results: [{ store: "player", key: "loadout", version: 3 }, { store: "readonly", key: "xp", version: 8, value: 450 }] })
  },
  {
    method: "playerData.clear",
    call: (sv) => sv.playerData.clear(42, PLAYER),
    http: "DELETE",
    url: `/studio-data/games/42/players/${PLAYER}/data`,
    reply: { status: 204 }
  },
  {
    method: "playerData.getMany",
    call: (sv) => sv.playerData.getMany(42, { players: [PLAYER], stores: ["player"], keys: ["coins"] }),
    http: "POST",
    url: "/studio-data/games/42/data/get",
    body: { players: [PLAYER], stores: ["player"], keys: ["coins"] },
    reply: ok({ players: { [PLAYER]: { player: { coins: dataEntry } } }, notFound: [] })
  },
  {
    method: "playerData.writeMany",
    call: (sv) => sv.playerData.writeMany(42, { writes: [{ player: PLAYER, ops: [{ op: "delete", store: "internal", key: "flag" }] }] }),
    http: "POST",
    url: "/studio-data/games/42/data/write",
    body: { writes: [{ player: PLAYER, ops: [{ op: "delete", store: "internal", key: "flag" }] }] },
    reply: ok({ results: [{ player: PLAYER, results: [{ store: "internal", key: "flag", version: null }] }] })
  },
  {
    method: "playerData.getGameData",
    call: (sv) => sv.playerData.getGameData(42, { stores: ["public"], keysOnly: false }),
    http: "GET",
    url: "/studio-data/games/42/game-data?stores=public&keysOnly=false",
    reply: ok({ data: { public: { motd: dataEntry } } })
  },
  {
    method: "playerData.updateGameData",
    call: (sv) => sv.playerData.updateGameData(42, { ops: [{ op: "set", store: "public", key: "motd", value: "Season 3 is live" }] }),
    http: "PATCH",
    url: "/studio-data/games/42/game-data",
    body: { ops: [{ op: "set", store: "public", key: "motd", value: "Season 3 is live" }] },
    reply: ok({ results: [{ store: "public", key: "motd", version: 4 }] })
  },
  {
    method: "playerData.import",
    call: (sv) => sv.playerData.import(42, { dryRun: true, rows: [{ type: "gameData", store: "public", data: { motd: "hi" } }] }),
    http: "POST",
    url: "/studio-data/games/42/import",
    body: { dryRun: true, rows: [{ type: "gameData", store: "public", data: { motd: "hi" } }] },
    reply: ok(report)
  },
  {
    method: "playerData.listErasedPlayers",
    call: (sv) => sv.playerData.listErasedPlayers({ since: new Date("2026-11-01T00:00:00.000Z") }),
    http: "GET",
    url: "/studio-data/erased-players?since=2026-11-01T00%3A00%3A00.000Z",
    reply: ok({ players: [{ id: PLAYER, erasedAt: "2026-11-02T00:00:00.000Z" }], next: "cur1", until: "2026-11-15T00:55:00.000Z", more: false })
  },
  // ── store ──
  {
    method: "store.getCatalog",
    call: (sv) => sv.store.getCatalog(),
    http: "GET",
    url: "/store/studio/catalog",
    reply: ok({ settings: { enabled: true, playerPurchases: true, playerConsume: false, updatedAt: null }, currencies: [], items: [] })
  },
  {
    method: "store.getPlayer",
    call: (sv) => sv.store.getPlayer("steam:76561198000000000"),
    http: "GET",
    url: "/store/studio/players/steam%3A76561198000000000",
    reply: ok({ player: { id: PLAYER }, balances: [{ currency: "GOLD", amount: 10 }], items: [] })
  },
  {
    method: "store.getHistory",
    call: (sv) => sv.store.getHistory(PLAYER, { before: "d1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a" }),
    http: "GET",
    url: `/store/studio/players/${PLAYER}/history?before=d1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a`,
    reply: ok({ txns: [], next: null })
  },
  {
    method: "store.grant",
    call: (sv) =>
      sv.store.grant(PLAYER, { lines: [{ currency: "GOLD", amount: 500 }, { sku: "sword_basic", quantity: 1 }], reason: "Season 3 reward" }, { idempotencyKey: "reward:s3:981" }),
    http: "POST",
    url: `/store/studio/players/${PLAYER}/grants`,
    body: { lines: [{ currency: "GOLD", amount: 500 }, { sku: "sword_basic", quantity: 1 }], reason: "Season 3 reward" },
    idempotencyKey: "reward:s3:981",
    reply: ok(txnResult, 201)
  },
  {
    method: "store.consume",
    call: (sv) => sv.store.consume(PLAYER, { lines: [{ instanceId: INSTANCE }, { currency: "GOLD", amount: 5 }] }),
    http: "POST",
    url: `/store/studio/players/${PLAYER}/consume`,
    body: { lines: [{ instanceId: INSTANCE }, { currency: "GOLD", amount: 5 }] },
    idempotencyKey: "auto",
    reply: ok({ ...txnResult, replayed: true }, 200)
  },
  {
    method: "store.purchase",
    call: (sv) => sv.store.purchase("studio:user-981", { sku: "sword_basic", currency: "GOLD", quantity: 1, expectedPrice: 100 }),
    http: "POST",
    url: "/store/studio/players/studio%3Auser-981/purchases",
    body: { sku: "sword_basic", currency: "GOLD", quantity: 1, expectedPrice: 100 },
    idempotencyKey: "auto",
    reply: ok(txnResult, 201)
  },
  {
    method: "store.updateItem",
    call: (sv) => sv.store.updateItem(PLAYER, INSTANCE, { custom: { skin: "gold" } }),
    http: "PATCH",
    url: `/store/studio/players/${PLAYER}/items/${INSTANCE}`,
    body: { custom: { skin: "gold" } },
    idempotencyKey: "auto",
    reply: ok(txnResult, 201)
  },
  {
    method: "store.reverse",
    call: (sv) => sv.store.reverse(PLAYER, { originalKey: "reward:s3:981", reason: "granted twice" }),
    http: "POST",
    url: `/store/studio/players/${PLAYER}/reversals`,
    body: { originalKey: "reward:s3:981", reason: "granted twice" },
    idempotencyKey: "auto",
    reply: ok(txnResult, 201)
  },
  {
    method: "store.syncMetaPurchases",
    call: (sv) => sv.store.syncMetaPurchases(PLAYER, { gameId: 42 }),
    http: "POST",
    url: `/store/studio/players/${PLAYER}/platform-purchases/meta`,
    body: { gameId: 42 },
    reply: ok({ granted: 1, alreadyGranted: 0, unmapped: 0, consumePending: 0 })
  },
  {
    method: "store.importCatalog",
    call: (sv) => sv.store.importCatalog({ dryRun: true, format: "sv", rows: [{ type: "currency", code: "GOLD", name: "Gold" }] }),
    http: "POST",
    url: "/store/studio/imports/catalog",
    body: { dryRun: true, format: "sv", rows: [{ type: "currency", code: "GOLD", name: "Gold" }] },
    reply: ok({ dryRun: true, counts: report.counts, results: [{ line: 1, status: "created", currency: "GOLD" }] })
  },
  {
    method: "store.importHoldings",
    call: (sv) => sv.store.importHoldings({ gameId: 42, dryRun: false, rows: [{ playerId: PLAYER, balances: { GOLD: 1200 } }] }),
    http: "POST",
    url: "/store/studio/imports/holdings",
    body: { gameId: 42, dryRun: false, rows: [{ playerId: PLAYER, balances: { GOLD: 1200 } }] },
    reply: ok({ dryRun: false, counts: report.counts, results: [{ line: 1, status: "updated", playerId: PLAYER }] })
  }
];

/** The spec's path template of an operation as a RegExp over a filled path. */
function templateRe(template: string): RegExp {
  const escape = (t: string) => t.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  return new RegExp(`^${template.split(/\{[^}]+\}/).map(escape).join("[^/]+")}$`);
}

function specOperation(operationId: string): { method: string; path: string } {
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) if (op?.operationId === operationId) return { method: method.toUpperCase(), path };
  }
  throw new Error(`no operation ${operationId} in the spec`);
}

describe("every client method", () => {
  it("has a case here", () => {
    expect(CASES.map((c) => c.method).sort()).toEqual(Object.keys(SURFACE).sort());
  });

  for (const c of CASES) {
    it(`${c.method} → ${SURFACE[c.method]}`, async () => {
      const { fetch, calls } = mockFetch(c.reply);
      const sv = new SplatterVault({ apiKey: KEY, baseUrl: `${BASE}/`, fetch });
      const result = await c.call(sv);

      expect(calls).toHaveLength(1);
      const req = calls[0]!;
      // URL and method, and both agree with the API description.
      expect(req.method).toBe(c.http);
      expect(req.url).toBe(`${BASE}${c.url}`);
      const opId = SURFACE[c.method]!;
      const fromSpec = specOperation(opId);
      expect(fromSpec.method).toBe(c.http);
      expect(OPERATIONS[opId].method).toBe(fromSpec.method);
      expect(new URL(req.url).pathname.replace(/^\/rest/, "")).toMatch(templateRe(fromSpec.path));
      // Headers.
      expect(req.headers["x-api-key"]).toBe(KEY);
      expect(req.headers["accept"]).toBe("application/json");
      expect(req.headers["user-agent"]).toMatch(/^splattervault-server-node\/\d+\.\d+\.\d+ node\/v\d+/);
      expect(req.headers["authorization"]).toBeUndefined();
      // No server operation declares ETags (see the contract test): never a conditional request, never Cache-Control.
      expect(req.headers["if-none-match"]).toBeUndefined();
      expect(req.headers["cache-control"]).toBeUndefined();
      if (c.idempotencyKey === "auto") expect(req.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      else if (c.idempotencyKey) expect(req.headers["idempotency-key"]).toBe(c.idempotencyKey);
      else expect(req.headers["idempotency-key"]).toBeUndefined();
      // Body.
      if (c.body === undefined) {
        expect(req.rawBody).toBeUndefined();
        expect(req.headers["content-type"]).toBeUndefined();
      } else {
        expect(req.body).toEqual(c.body);
        expect(req.headers["content-type"]).toBe("application/json");
      }
      // Answer.
      expect(result).toEqual(c.reply.status === 204 ? undefined : c.reply.body);
    });
  }
});

describe("request details", () => {
  it("serverPools.claim sends an empty object when there is no body", async () => {
    const { fetch, calls } = mockFetch(ok({ sessionId: 1, serverInstanceId: 2, connection: null }));
    await new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch }).serverPools.claim(3);
    expect(calls[0]!.body).toEqual({});
  });

  it("leaves undefined query values out and keeps the base URL's path", async () => {
    const { fetch, calls } = mockFetch(ok([]));
    await new SplatterVault({ apiKey: KEY, baseUrl: "http://127.0.0.1:8790/rest///", fetch }).sessions.list({ status: undefined });
    expect(calls[0]!.url).toBe("http://127.0.0.1:8790/rest/credits/sessions");
  });

  it("listErasedPlayers sends cursor and never since with it", async () => {
    const { fetch, calls } = mockFetch(ok({ players: [], next: "n", until: "u", more: false }));
    await new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch }).playerData.listErasedPlayers({ cursor: "abc", since: "2026-01-01T00:00:00Z" });
    expect(calls[0]!.url).toBe(`${BASE}/studio-data/erased-players?cursor=abc`);
  });

  it("refuses a missing path parameter before sending", async () => {
    const { fetch, calls } = mockFetch(ok({}));
    const sv = new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch });
    await expect(sv.store.getPlayer("")).rejects.toThrow(TypeError);
    await expect(sv.sessions.get(undefined as unknown as number)).rejects.toThrow(/id is required/);
    expect(calls).toHaveLength(0);
  });

  it("URL-encodes path parameters (no path traversal)", async () => {
    const { fetch, calls } = mockFetch(ok({ player: { id: PLAYER }, balances: [], items: [] }));
    await new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch }).store.getPlayer("../../admin?x=1#y");
    expect(calls[0]!.url).toBe(`${BASE}/store/studio/players/..%2F..%2Fadmin%3Fx%3D1%23y`);
  });

  it("keeps extra headers but never lets them replace the managed ones", async () => {
    const { fetch, calls } = mockFetch(ok(txnResult, 201));
    await new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch, userAgent: "my-matchmaker/2.1" }).store.grant(
      PLAYER,
      { lines: [{ currency: "GOLD", amount: 1 }] },
      { idempotencyKey: "k-1", headers: { "x-request-id": "trace-123", "X-API-Key": "sv_other", "idempotency-key": "nope" } }
    );
    const h = calls[0]!.headers;
    expect(h["x-request-id"]).toBe("trace-123");
    expect(h["x-api-key"]).toBe(KEY);
    expect(h["idempotency-key"]).toBe("k-1");
    expect(h["user-agent"]).toMatch(/^my-matchmaker\/2\.1 splattervault-server-node\//);
  });

  it("refuses an invalid Idempotency-Key, and one on an operation that takes none", async () => {
    const { fetch, calls } = mockFetch(ok(txnResult, 201));
    const sv = new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch });
    await expect(sv.store.grant(PLAYER, { lines: [{ currency: "GOLD", amount: 1 }] }, { idempotencyKey: "has space" })).rejects.toThrow(
      /idempotencyKey/
    );
    await expect(sv.store.grant(PLAYER, { lines: [{ currency: "GOLD", amount: 1 }] }, { idempotencyKey: "x".repeat(129) })).rejects.toThrow(
      /idempotencyKey/
    );
    await expect(sv.sessions.create({}, { idempotencyKey: "k" } as never)).rejects.toThrow(/takes no idempotencyKey/);
    expect(calls).toHaveLength(0);
  });

  it("makes a new Idempotency-Key per call", async () => {
    const { fetch, calls } = mockFetch(ok(txnResult, 201));
    const sv = new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch });
    await sv.store.grant(PLAYER, { lines: [{ currency: "GOLD", amount: 1 }] });
    await sv.store.grant(PLAYER, { lines: [{ currency: "GOLD", amount: 1 }] });
    expect(calls[0]!.headers["idempotency-key"]).not.toBe(calls[1]!.headers["idempotency-key"]);
  });
});

describe("a caller's If-None-Match", () => {
  it("goes with Cache-Control: max-age=0 (Node's fetch would add no-cache and the API would never answer 304)", async () => {
    const { fetch, calls } = mockFetch(ok({ data: {} }));
    await new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch }).playerData.getGameData(42, undefined, { headers: { "If-None-Match": 'W/"a-b"' } });
    expect(calls[0]!.headers["if-none-match"]).toBe('W/"a-b"');
    expect(calls[0]!.headers["cache-control"]).toBe("max-age=0");
  });

  it("keeps the caller's own Cache-Control", async () => {
    const { fetch, calls } = mockFetch(ok({ data: {} }));
    await new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch }).playerData.getGameData(42, undefined, {
      headers: { "if-none-match": 'W/"a-b"', "cache-control": "max-age=5" }
    });
    expect(calls[0]!.headers["cache-control"]).toBe("max-age=5");
  });

  it("a 304 answer rejects with status 304 (and is not retried)", async () => {
    const { fetch, calls } = mockFetch({ status: 304 });
    const err = await new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch })
      .playerData.getGameData(42, undefined, { headers: { "If-None-Match": 'W/"a-b"' } })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 304, code: null, attempts: 1 });
    expect(calls).toHaveLength(1);
  });
});

describe("pagination helpers", () => {
  it("historyPages walks next until null", async () => {
    const { fetch, calls } = mockFetch(
      ok({ txns: [{ id: "t1" }], next: "c1" }),
      ok({ txns: [{ id: "t2" }], next: "c2" }),
      ok({ txns: [{ id: "t3" }], next: null })
    );
    const sv = new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch });
    const ids: string[] = [];
    for await (const page of sv.store.historyPages(PLAYER)) for (const t of page.txns) ids.push(t.id);
    expect(ids).toEqual(["t1", "t2", "t3"]);
    expect(calls.map((c) => new URL(c.url).search)).toEqual(["", "?before=c1", "?before=c2"]);
  });

  it("erasedPlayerPages follows more and passes next as cursor", async () => {
    const { fetch, calls } = mockFetch(
      ok({ players: [{ id: "p1", erasedAt: "x" }], next: "n1", until: "u", more: true }),
      ok({ players: [{ id: "p2", erasedAt: "x" }], next: "n2", until: "u", more: false })
    );
    const sv = new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch });
    const pages = [];
    for await (const page of sv.playerData.erasedPlayerPages({ since: "2026-11-01T00:00:00Z" })) pages.push(page.next);
    expect(pages).toEqual(["n1", "n2"]);
    expect(calls.map((c) => new URL(c.url).search)).toEqual(["?since=2026-11-01T00%3A00%3A00Z", "?cursor=n1"]);
  });

  it("stops when the caller breaks out", async () => {
    const { fetch, calls } = mockFetch(ok({ txns: [], next: "again" }));
    const sv = new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch });
    let n = 0;
    for await (const _page of sv.store.historyPages(PLAYER)) if (++n === 2) break;
    expect(calls).toHaveLength(2);
  });
});
