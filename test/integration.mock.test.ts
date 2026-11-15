// Integration tests against the SplatterVault studio API mock in tools/sdk-mock (a local stateful server with fault
// injection and a request log). Skipped unless SV_MOCK_URL is set (the mock's root or its /rest base), e.g.:
//
//   node tools/sdk-mock/server.mjs --port 8787 &
//   SV_MOCK_URL=http://127.0.0.1:8787/rest npm test
//
// The mock serves the player-facing routes and the JWKS; it does not serve the organization-key routes (they answer
// 404 not_found), so those are used here for the transport: retries, Idempotency-Key, timeouts, faults, error shape.
import { beforeEach, describe, expect, it } from "vitest";

import { createPlayerTokenVerifier, PlayerTokenError, SplatterVault, SplatterVaultError, verifyPlayerToken } from "../src/index.js";

const MOCK = process.env.SV_MOCK_URL?.replace(/\/+$/, "").replace(/\/rest$/, "");
const REST = `${MOCK}/rest`;
const GAME_ID = 4242;
const PLAYER = "8f14e45f-ceea-467f-a8f1-2a0e3f5b1c9d";

interface LoggedRequest {
  method: string;
  path: string;
  status: number | string | null;
  headers: { idempotencyKey: string | null; xApiKey: boolean; authorization: boolean };
}

async function control(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${MOCK}/__mock/${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`mock control ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
const fault = (f: Record<string, unknown>) => control("POST", "fault", f);
const requests = async (path: string) => ((await control("GET", `requests?path=${encodeURIComponent(path)}`)) as { requests: LoggedRequest[] }).requests;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${REST}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const sv = (extra: Partial<ConstructorParameters<typeof SplatterVault>[0]> = {}) =>
  new SplatterVault({ apiKey: "sv_org_mock_key", baseUrl: REST, retry: { baseDelayMs: 20, maxDelayMs: 40 }, ...extra });

describe.skipIf(!MOCK)("against the mock API", () => {
  beforeEach(async () => {
    await control("POST", "reset");
    await control("DELETE", "faults");
    await control("DELETE", "requests");
  });

  describe("player tokens the mock issues", () => {
    it("verifies a guest, a studio-backend and a Steam sign-in's tokens offline", async () => {
      const verifier = createPlayerTokenVerifier({ baseUrl: REST, gameId: GAME_ID });
      const guest = await post<{ token: string; player: { id: string } }>("/player-auth/device/new", { gameId: GAME_ID });
      await expect(verifier.verify(guest.token)).resolves.toMatchObject({ sub: guest.player.id, game: GAME_ID, aud: `sv-player:${GAME_ID}`, amr: ["device"] });

      const studio = (await control("POST", "studio-token", { externalId: "user-981" })) as { token: string; player: { id: string } };
      const studioClaims = await verifier.verify(studio.token);
      expect(studioClaims).toMatchObject({ sub: studio.player.id, amr: ["studio"] });
      expect(studioClaims.app).toBeUndefined();

      const steam = await post<{ token: string }>("/player-auth/steam", { gameId: GAME_ID, ticket: "deadbeef" });
      await expect(verifier.verify(steam.token)).resolves.toMatchObject({ amr: ["steam"] });

      // One JWKS fetch for all three (private, max-age=300), never with the API key.
      const keyFetches = await requests("/player-auth/keys");
      expect(keyFetches).toHaveLength(1);
      expect(keyFetches[0]!.headers.xApiKey).toBe(false);
    });

    it("refuses the token for another game and a tampered token", async () => {
      const guest = await post<{ token: string }>("/player-auth/device/new", { gameId: GAME_ID });
      const err = await verifyPlayerToken(guest.token, { gameId: GAME_ID + 1, baseUrl: REST }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlayerTokenError);
      expect(err).toMatchObject({ code: "token_invalid", reason: "audience" });
      const [h, p, s] = guest.token.split(".") as [string, string, string];
      const flipped = `${h}.${p}.${s.startsWith("A") ? "B" : "A"}${s.slice(1)}`;
      await expect(verifyPlayerToken(flipped, { gameId: GAME_ID, baseUrl: REST })).rejects.toMatchObject({ reason: "signature" });
    });

    it("sv.verifyPlayerToken uses the client's base URL", async () => {
      const guest = await post<{ token: string; player: { id: string } }>("/player-auth/device/new", { gameId: GAME_ID });
      await expect(sv().verifyPlayerToken(guest.token, { gameId: GAME_ID })).resolves.toMatchObject({ sub: guest.player.id });
    });

    it("answers keys_unavailable when the JWKS route fails", async () => {
      const guest = await post<{ token: string }>("/player-auth/device/new", { gameId: GAME_ID });
      await fault({ match: "/player-auth/keys", status: 503, times: 1 });
      // minRefetchIntervalMs 0: try again at once after the failure (by default a failed fetch waits 10 s).
      const verifier = createPlayerTokenVerifier({ baseUrl: REST, gameId: GAME_ID, minRefetchIntervalMs: 0 });
      await expect(verifier.verify(guest.token)).rejects.toMatchObject({ code: "keys_unavailable" });
      await expect(verifier.verify(guest.token)).resolves.toBeTruthy();
    });
  });

  describe("transport over real HTTP", () => {
    it("retries a store grant through two 503s with the same Idempotency-Key and the API key", async () => {
      await fault({ match: "/store/studio/players", method: "POST", status: 503, times: 2 });
      const err = (await sv().store.grant(PLAYER, { lines: [{ currency: "COINS", amount: 5 }] }).catch((e: unknown) => e)) as SplatterVaultError;
      // The mock does not serve this organization-key route: after the faults, its 404 not_found comes through.
      expect(err).toBeInstanceOf(SplatterVaultError);
      expect(err).toMatchObject({ status: 404, code: "not_found", attempts: 3 });
      const logged = await requests("/grants");
      expect(logged.map((r) => r.status)).toEqual([503, 503, 404]);
      expect(new Set(logged.map((r) => r.headers.idempotencyKey)).size).toBe(1);
      expect(logged[0]!.headers.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      expect(logged.every((r) => r.headers.xApiKey && !r.headers.authorization)).toBe(true);
    });

    it("honours Retry-After from a 429", async () => {
      await fault({ match: "/store/studio/catalog", status: 429, retryAfter: 1, times: 1 });
      const started = Date.now();
      await expect(sv().store.getCatalog()).rejects.toMatchObject({ status: 404, attempts: 2 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    });

    it("a dropped connection is network_error; a GET is retried, a session create never", async () => {
      await fault({ match: "/credits", method: "GET", drop: true, times: 1 });
      await expect(sv().billing.getCredits()).rejects.toMatchObject({ status: 404, attempts: 2 });

      await fault({ match: "/credits/sessions", method: "POST", drop: true, times: 5 });
      await expect(sv().sessions.create({ gameTypeConfigKey: "g" })).rejects.toMatchObject({ status: 0, code: "network_error", attempts: 1 });
      expect(await requests("/credits/sessions")).toHaveLength(1);
    });

    it("a lost answer (dropped after the work) is retried for a store change with the same key", async () => {
      await fault({ match: "/consume", method: "POST", drop: true, after: true, times: 1 });
      await expect(sv().store.consume(PLAYER, { lines: [{ sku: "potion_small", quantity: 1 }] }, { idempotencyKey: "use:potion:1" })).rejects.toMatchObject({
        status: 404,
        attempts: 2
      });
      expect((await requests("/consume")).map((r) => r.headers.idempotencyKey)).toEqual(["use:potion:1", "use:potion:1"]);
    });

    it("times out a slow answer", async () => {
      await fault({ match: "/org/credits", delayMs: 1500, times: 1 });
      await expect(sv({ timeoutMs: 300, maxRetries: 0 }).billing.getOrgCredits()).rejects.toMatchObject({ status: 0, code: "timeout" });
    });

    it("maps a real studio-shaped refusal with its HTTP details", async () => {
      await fault({ match: "/studio-data/games", status: 409, error: "version_conflict", message: "The data changed.", times: 1 });
      const err = (await sv()
        .playerData.update(GAME_ID, PLAYER, { ops: [{ op: "set", store: "player", key: "k", value: 1, ifVersion: 1 }] })
        .catch((e: unknown) => e)) as SplatterVaultError;
      expect(err).toMatchObject({ status: 409, code: "version_conflict", attempts: 1 });
      expect(err.message).toBe("version_conflict (HTTP 409): The data changed.");
    });
  });
});
