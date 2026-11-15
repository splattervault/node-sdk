// The contract between this SDK and the Studio API description (openapi/studio-api.json): every operation a studio's
// backend calls with its organization API key has exactly one client method, and every client method is one of them.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { OPERATIONS, SplatterVault } from "../src/index.js";
import { KEY, mockFetch } from "./helpers/mockFetch.js";
import { HELPERS, NAMESPACES, SURFACE } from "./surface.js";

interface SpecOperation {
  operationId: string;
  tags?: string[];
  security?: Record<string, string[]>[];
  parameters?: { name: string; in: string; required?: boolean }[];
}
const spec = JSON.parse(readFileSync(new URL("../openapi/studio-api.json", import.meta.url), "utf8")) as {
  paths: Record<string, Record<string, SpecOperation>>;
};

/** The tags of the routes a studio backend or game server calls (the player-token routes belong to game clients). */
const SERVER_TAGS = ["Game-server sessions", "Billing", "Player sign-in (studio backend)", "Player data (studio backend)", "Store (studio backend)"];

const specOps = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([, op]) => op && typeof op === "object" && typeof op.operationId === "string")
    .map(([method, op]) => ({ ...op, method: method.toUpperCase(), path }))
);
const orgKeyOps = specOps.filter((op) => (op.security ?? []).some((s) => "orgApiKey" in s));

describe("contract with openapi/studio-api.json", () => {
  it("every orgApiKey operation is in a server tag (none is left out by the tag filter)", () => {
    const outside = orgKeyOps.filter((op) => !(op.tags ?? []).some((t) => SERVER_TAGS.includes(t)));
    expect(outside.map((op) => op.operationId)).toEqual([]);
  });

  it("OPERATIONS holds exactly the orgApiKey operations", () => {
    const fromSpec = orgKeyOps.map((op) => op.operationId).sort();
    expect(Object.keys(OPERATIONS).sort()).toEqual(fromSpec);
  });

  it("each operation's method and path match the description", () => {
    for (const op of orgKeyOps) {
      const mine = OPERATIONS[op.operationId as keyof typeof OPERATIONS];
      expect({ id: op.operationId, method: mine.method, path: mine.path }).toEqual({ id: op.operationId, method: op.method, path: op.path });
    }
  });

  it("exactly the operations that take an Idempotency-Key send one", () => {
    for (const op of orgKeyOps) {
      const takesKey = (op.parameters ?? []).some((p) => p.in === "header" && p.name.toLowerCase() === "idempotency-key");
      const mine = OPERATIONS[op.operationId as keyof typeof OPERATIONS];
      expect({ id: op.operationId, sendsKey: mine.retry === "idempotency-key" }).toEqual({ id: op.operationId, sendsKey: takesKey });
    }
  });

  it("no server operation declares If-None-Match, ETag or 304 (the SDK makes no conditional requests)", () => {
    // If one ever does: add conditional support for it, and send "Cache-Control: max-age=0" with If-None-Match (Node's
    // fetch adds "no-cache" to such a request, and the API then never answers 304).
    const conditional = orgKeyOps
      .filter((op) => {
        const responses = (op as unknown as { responses?: Record<string, { headers?: Record<string, unknown> }> }).responses ?? {};
        return (
          (op.parameters ?? []).some((p) => /^if-(none-)?match$/i.test(p.name)) ||
          "304" in responses ||
          Object.values(responses).some((r) => Object.keys(r.headers ?? {}).some((h) => h.toLowerCase() === "etag"))
        );
      })
      .map((op) => op.operationId);
    expect(conditional).toEqual([]);
  });

  it("only GETs and documented-safe operations are retried without a condition", () => {
    const safeWrites = Object.entries(OPERATIONS)
      .filter(([, op]) => op.retry === "safe" && op.method !== "GET")
      .map(([id]) => id)
      .sort();
    // Each one is quoted in src/operations.ts: lookups, imports ("the same rows again change nothing"), clearing data.
    expect(safeWrites).toEqual([
      "playerAuth.studio.importPlayers",
      "store.studio.importCatalog",
      "store.studio.importHoldings",
      "studioData.clearPlayerData",
      "studioData.getPlayersData",
      "studioData.importData",
      "studioData.resolvePlayers"
    ]);
    for (const [id, op] of Object.entries(OPERATIONS)) if (op.method === "GET") expect({ id, retry: op.retry }).toEqual({ id, retry: "safe" });
  });

  it("every operation has exactly one client method, and every method maps to one", () => {
    const mapped = Object.values(SURFACE).sort();
    expect(mapped).toEqual(Object.keys(OPERATIONS).sort());
    expect(new Set(mapped).size).toBe(mapped.length);
    for (const opId of Object.values(HELPERS)) expect(Object.keys(OPERATIONS)).toContain(opId);
  });

  it("the client has no method that is neither an operation nor a helper", () => {
    const { fetch } = mockFetch({ body: {} });
    const sv = new SplatterVault({ apiKey: KEY, fetch }) as unknown as Record<string, unknown>;
    const found: string[] = [];
    for (const ns of NAMESPACES) {
      const target = ns.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], sv) as object;
      expect(target, ns).toBeTypeOf("object");
      for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(target))) {
        if (name === "constructor") continue;
        if (typeof (target as Record<string, unknown>)[name] === "function") found.push(`${ns}.${name}`);
      }
    }
    expect(found.sort()).toEqual([...Object.keys(SURFACE), ...Object.keys(HELPERS)].sort());
    // The client's own namespaces are exactly the ones listed.
    const topLevel = Object.keys(sv).filter((k) => typeof sv[k] === "object" && sv[k] !== null);
    expect(topLevel.sort()).toEqual(NAMESPACES.filter((n) => !n.includes(".")).sort());
  });
});
