import { describe, expect, it } from "vitest";

import { freshnessMs, importJwks } from "../src/playerToken/jwks.js";
import { createPlayerTokenVerifier, PlayerTokenError, PlayerTokenVerifier, SplatterVault, verifyPlayerToken } from "../src/index.js";
import { BASE, KEY, mockFetch, type Reply } from "./helpers/mockFetch.js";
import { makeKey, PLAYER_ID, signToken, type TestKey } from "./helpers/playerTokens.js";

const T0 = Date.parse("2026-11-15T01:00:00.000Z");
const S0 = Math.floor(T0 / 1000);

const jwks = (keys: TestKey[], cacheControl = "private, max-age=300", extra: Record<string, string> = {}): Reply => ({
  status: 200,
  body: { keys: keys.map((k) => k.jwk) },
  headers: { "Cache-Control": cacheControl, ...extra }
});

function setup(steps: Parameters<typeof mockFetch>, options: Partial<ConstructorParameters<typeof PlayerTokenVerifier>[0]> = {}) {
  let now = T0;
  const { fetch, calls } = mockFetch(...steps);
  const verifier = new PlayerTokenVerifier({ baseUrl: BASE, fetch, gameId: 42, now: () => now, ...options });
  return {
    verifier,
    calls,
    advance: (ms: number) => {
      now += ms;
    }
  };
}

async function refusal(p: Promise<unknown>): Promise<PlayerTokenError> {
  const err = await p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(PlayerTokenError);
  return err as PlayerTokenError;
}

describe("verifying a player token", () => {
  it("accepts a token the API issued for this game and answers its claims", async () => {
    const key = makeKey();
    const { verifier, calls } = setup([jwks([key])]);
    const claims = await verifier.verify(signToken(key, S0));
    expect(claims).toMatchObject({ iss: "splattervault", aud: "sv-player:42", sub: PLAYER_ID, game: 42, org: 7, scope: "org:7", amr: ["steam"], app: "480" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/player-auth/keys`);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers["x-api-key"]).toBeUndefined();
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
  });

  it("accepts a personal game's token and a studio sign-in (no app)", async () => {
    const key = makeKey();
    const { verifier } = setup([jwks([key])]);
    await expect(verifier.verify(signToken(key, S0, { org: null }))).resolves.toMatchObject({ org: null, scope: "game:42" });
    await expect(verifier.verify(signToken(key, S0, { amr: ["studio"] }))).resolves.not.toHaveProperty("app");
  });

  it("accepts a sign-in method added after this SDK (forward compatible), still one method", async () => {
    const key = makeKey();
    const { verifier } = setup([jwks([key])]);
    await expect(verifier.verify(signToken(key, S0, { amr: ["epic"] }))).resolves.toMatchObject({ amr: ["epic"] });
    expect((await refusal(verifier.verify(signToken(key, S0, { amr: ["steam", "meta"] })))).reason).toBe("claims");
    expect((await refusal(verifier.verify(signToken(key, S0, { amr: [] })))).reason).toBe("claims");
  });

  it("refuses another game's token (audience), even of the same studio and player", async () => {
    const key = makeKey();
    const { verifier } = setup([jwks([key])]);
    const err = await refusal(verifier.verify(signToken(key, S0, { game: 43 })));
    expect(err).toMatchObject({ code: "token_invalid", reason: "audience" });
    await expect(verifier.verify(signToken(key, S0, { game: 43 }), { gameId: [42, 43] })).resolves.toMatchObject({ game: 43 });
  });

  it("refuses an aud that does not name the token's game", async () => {
    const key = makeKey();
    const { verifier } = setup([jwks([key])]);
    expect(await refusal(verifier.verify(signToken(key, S0, { claims: { aud: "sv-player:41" } })))).toMatchObject({ reason: "claims" });
    expect(await refusal(verifier.verify(signToken(key, S0, { claims: { aud: ["sv-player:42"] } })))).toMatchObject({ reason: "issuer" });
  });

  it("checks exp with a 30-second tolerance: token_expired only after it", async () => {
    const key = makeKey();
    const { verifier, advance } = setup([jwks([key], "private, max-age=86400")]);
    const token = signToken(key, S0);
    advance((3600 + 30) * 1000);
    await expect(verifier.verify(token)).resolves.toMatchObject({ sub: PLAYER_ID });
    advance(1000);
    expect(await refusal(verifier.verify(token))).toMatchObject({ code: "token_expired", reason: "expired", message: "Token expired" });
  });

  it("refuses a token issued in the future beyond the tolerance", async () => {
    const key = makeKey();
    const { verifier } = setup([jwks([key])]);
    await expect(verifier.verify(signToken(key, S0, { iat: S0 + 30 }))).resolves.toBeTruthy();
    expect(await refusal(verifier.verify(signToken(key, S0, { iat: S0 + 31 })))).toMatchObject({ code: "token_invalid", reason: "not_yet_valid" });
  });

  it("refuses any nbf, as the API does (player tokens never carry one)", async () => {
    const key = makeKey();
    const { verifier } = setup([jwks([key])]);
    expect(await refusal(verifier.verify(signToken(key, S0, { claims: { nbf: S0 - 10 } })))).toMatchObject({ reason: "claims" });
  });

  it("refuses lifetimes the API never issues", async () => {
    const key = makeKey();
    const { verifier } = setup([jwks([key])]);
    expect(await refusal(verifier.verify(signToken(key, S0, { exp: S0 + 3601 })))).toMatchObject({ reason: "lifetime" });
    expect(await refusal(verifier.verify(signToken(key, S0, { exp: S0 })))).toMatchObject({ reason: "lifetime" });
    expect(await refusal(verifier.verify(signToken(key, S0, { claims: { exp: `${S0 + 60}` } })))).toMatchObject({ reason: "claims" });
  });

  it("refuses a wrong issuer and malformed claims", async () => {
    const key = makeKey();
    const { verifier } = setup([jwks([key])]);
    const cases: Record<string, unknown>[] = [
      { iss: "evil" },
      { sub: PLAYER_ID.toUpperCase() },
      { sub: "not-a-uuid" },
      { scope: "org:8" },
      { scope: "team:7" },
      { org: 0, scope: "org:0" },
      { game: 0, aud: "sv-player:0" },
      { gk: "x".repeat(256) },
      { jti: "short" },
      { jti: undefined },
      { amr: "steam" }
    ];
    for (const claims of cases) {
      const err = await refusal(verifier.verify(signToken(key, S0, { claims })));
      expect(err.code, JSON.stringify(claims)).toBe("token_invalid");
    }
    // An app on a studio sign-in, or a malformed app.
    expect(await refusal(verifier.verify(signToken(key, S0, { amr: ["studio"], app: "1" })))).toMatchObject({ reason: "claims" });
    expect(await refusal(verifier.verify(signToken(key, S0, { app: "has space" })))).toMatchObject({ reason: "claims" });
  });

  it("refuses bad headers: alg, typ, crit, jku, jwk, x5u, kid", async () => {
    const key = makeKey();
    const { verifier } = setup([jwks([key])]);
    for (const header of [{ alg: "none" }, { alg: "HS256" }, { alg: "ES256" }, { typ: "at+jwt" }, { crit: ["exp"] }, { jku: "https://evil" }, { jwk: key.jwk }, { x5u: "https://evil" }, { kid: "ABCDEF0123456789" }, { kid: 7 }]) {
      const err = await refusal(verifier.verify(signToken(key, S0, { header })));
      expect({ header, reason: err.reason }).toEqual({ header, reason: "header" });
    }
  });

  it("refuses a forged or tampered signature", async () => {
    const key = makeKey();
    const other = makeKey();
    const { verifier } = setup([jwks([key])]);
    const token = signToken(key, S0);
    const [h, p, s] = token.split(".") as [string, string, string];
    // Another key's signature under this key's kid.
    const forged = signToken({ ...other, kid: key.kid }, S0);
    expect(await refusal(verifier.verify(forged))).toMatchObject({ reason: "signature" });
    // Changed claims.
    const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...claims, sub: "11111111-1111-4111-8111-111111111111" })).toString("base64url")}.${s}`;
    expect(await refusal(verifier.verify(tampered))).toMatchObject({ reason: "signature" });
    // A non-canonical signature encoding (an extra character) and a short one.
    expect(await refusal(verifier.verify(`${h}.${p}.${s}A`))).toMatchObject({ reason: "signature" });
    expect(await refusal(verifier.verify(`${h}.${p}.${s.slice(0, 40)}`))).toMatchObject({ reason: "signature" });
  });

  it("refuses things that are not tokens", async () => {
    const key = makeKey();
    const { verifier, calls } = setup([jwks([key])]);
    for (const t of ["", "a.b", "a.b.c.d", "a.b.c=", "a+b.c.d", "x".repeat(2049), 42 as unknown as string]) {
      expect((await refusal(verifier.verify(t))).reason).toMatch(/malformed|header/);
    }
    expect(calls).toHaveLength(0);
  });

  it("needs a game id", async () => {
    const key = makeKey();
    const { fetch } = mockFetch(jwks([key]));
    const v = new PlayerTokenVerifier({ baseUrl: BASE, fetch, now: () => T0 });
    await expect(v.verify(signToken(key, S0))).rejects.toThrow(/gameId is required/);
    await expect(v.verify(signToken(key, S0), { gameId: [] })).rejects.toThrow(/gameId is required/);
    expect(() => new PlayerTokenVerifier({ gameId: -1 })).toThrow(/positive integer/);
  });
});

describe("the key set (JWKS)", () => {
  it("is fetched once and kept for its Cache-Control max-age", async () => {
    const key = makeKey();
    const { verifier, calls, advance } = setup([jwks([key], "private, max-age=300")]);
    await verifier.verify(signToken(key, S0));
    advance(299_000);
    await verifier.verify(signToken(key, S0 + 299));
    expect(calls).toHaveLength(1);
    advance(1_000);
    await verifier.verify(signToken(key, S0 + 300));
    expect(calls).toHaveLength(2);
  });

  it("takes Age off max-age; a no-store answer is still kept for the 60 s floor", async () => {
    expect(freshnessMs("private, max-age=300", "100", 60_000)).toBe(200_000);
    expect(freshnessMs("max-age=300", "400", 60_000)).toBe(0);
    expect(freshnessMs("no-store", null, 60_000)).toBe(0);
    expect(freshnessMs("no-cache, max-age=300", null, 60_000)).toBe(0);
    expect(freshnessMs(null, null, 60_000)).toBe(60_000);
    expect(freshnessMs("private", null, 60_000)).toBe(60_000);
    expect(freshnessMs("max-age=abc", null, 60_000)).toBe(0);

    const key = makeKey();
    const { verifier, calls, advance } = setup([jwks([key], "no-store")]);
    await verifier.verify(signToken(key, S0));
    await verifier.verify(signToken(key, S0));
    expect(calls).toHaveLength(1);
    advance(60_000);
    await verifier.verify(signToken(key, S0 + 60));
    expect(calls).toHaveLength(2);
  });

  it("fetches again when a token names an unknown kid (a rotation), at most once per minRefetchIntervalMs", async () => {
    const oldKey = makeKey();
    const newKey = makeKey();
    const { verifier, calls, advance } = setup([jwks([oldKey]), jwks([newKey, oldKey]), jwks([newKey, oldKey])]);
    await verifier.verify(signToken(oldKey, S0));
    advance(10_000);
    // The new key signs before this verifier's cache expired: one refetch, then it verifies.
    await expect(verifier.verify(signToken(newKey, S0 + 10))).resolves.toBeTruthy();
    expect(calls).toHaveLength(2);
    // A forged kid right after: no refetch storm.
    const stranger = makeKey();
    expect(await refusal(verifier.verify(signToken(stranger, S0 + 10)))).toMatchObject({ code: "token_invalid", reason: "unknown_kid" });
    expect(calls).toHaveLength(2);
    advance(10_000);
    expect(await refusal(verifier.verify(signToken(stranger, S0 + 20)))).toMatchObject({ reason: "unknown_kid" });
    expect(calls).toHaveLength(3);
  });

  it("shares one fetch between concurrent verifications", async () => {
    const key = makeKey();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { verifier, calls } = setup([
      async () => {
        await gate;
        return jwks([key]);
      }
    ]);
    const all = Promise.all(Array.from({ length: 20 }, () => verifier.verify(signToken(key, S0))));
    await new Promise((r) => setTimeout(r, 5));
    release();
    await expect(all).resolves.toHaveLength(20);
    expect(calls).toHaveLength(1);
  });

  it("answers keys_unavailable when the keys cannot be fetched (player sign-in off, network down)", async () => {
    const key = makeKey();
    const off = setup([{ status: 503, body: { error: "player_sign_in_disabled", message: "Player sign-in is off." } }]);
    expect(await refusal(off.verifier.verify(signToken(key, S0)))).toMatchObject({ code: "keys_unavailable", reason: "keys" });
    const down = setup([new TypeError("fetch failed")]);
    const err = await refusal(down.verifier.verify(signToken(key, S0)));
    expect(err).toMatchObject({ code: "keys_unavailable" });
    expect(err.cause).toBeInstanceOf(Error);
    const junk = setup([{ status: 200, text: "<html>" }]);
    expect(await refusal(junk.verifier.verify(signToken(key, S0)))).toMatchObject({ code: "keys_unavailable" });
  });

  it("keeps using the expired set for staleIfErrorSeconds when a refetch fails, then refuses", async () => {
    const key = makeKey();
    const { verifier, calls, advance } = setup([jwks([key], "max-age=300"), new TypeError("fetch failed")], { staleIfErrorSeconds: 600 });
    await verifier.verify(signToken(key, S0));
    advance(301_000);
    await expect(verifier.verify(signToken(key, S0 + 301))).resolves.toBeTruthy();
    expect(calls).toHaveLength(2);
    // Right after a failure the old set serves without another fetch.
    await expect(verifier.verify(signToken(key, S0 + 301))).resolves.toBeTruthy();
    expect(calls).toHaveLength(2);
    advance(600_000);
    expect(await refusal(verifier.verify(signToken(key, S0 + 901)))).toMatchObject({ code: "keys_unavailable" });
  });

  it("staleIfErrorSeconds: 0 refuses as soon as the refetch fails", async () => {
    const key = makeKey();
    const { verifier, advance } = setup([jwks([key], "max-age=60"), new TypeError("fetch failed")], { staleIfErrorSeconds: 0 });
    await verifier.verify(signToken(key, S0));
    advance(61_000);
    expect(await refusal(verifier.verify(signToken(key, S0 + 61)))).toMatchObject({ code: "keys_unavailable" });
  });

  it("skips keys it cannot use instead of failing the set", () => {
    const key = makeKey();
    const keys = importJwks({
      keys: [
        { kty: "RSA", kid: "0000000000000000", n: "x", e: "AQAB" },
        { kty: "OKP", crv: "X25519", kid: "1111111111111111", x: key.x },
        { kty: "OKP", crv: "Ed25519", kid: "short", x: key.x },
        { kty: "OKP", crv: "Ed25519", kid: "2222222222222222", x: "too-short" },
        { kty: "OKP", crv: "Ed25519", kid: "3333333333333333", x: key.x, alg: "ES256" },
        key.jwk
      ]
    });
    expect([...keys.keys()]).toEqual([key.kid]);
    expect(() => importJwks({})).toThrow(/no keys/);
  });

  it("can verify fully offline against a saved key set", async () => {
    const key = makeKey();
    const v = createPlayerTokenVerifier({ keys: { keys: [key.jwk] }, gameId: 42, now: () => T0 });
    await expect(v.verify(signToken(key, S0))).resolves.toMatchObject({ sub: PLAYER_ID });
    expect(await refusal(v.verify(signToken(makeKey(), S0)))).toMatchObject({ reason: "unknown_kid" });
  });
});

describe("verifyPlayerToken() and sv.verifyPlayerToken()", () => {
  it("the standalone function caches the keys per URL and fetch", async () => {
    const key = makeKey();
    const { fetch, calls } = mockFetch(jwks([key]));
    const token = signToken(key, Math.floor(Date.now() / 1000));
    await expect(verifyPlayerToken(token, { gameId: 42, baseUrl: `${BASE}/`, fetch })).resolves.toMatchObject({ game: 42 });
    await expect(verifyPlayerToken(token, { gameId: 42, baseUrl: BASE, fetch })).resolves.toMatchObject({ game: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/player-auth/keys`);
    await expect(verifyPlayerToken(token, { gameId: 42, keys: { keys: [key.jwk] } })).resolves.toMatchObject({ game: 42 });
  });

  it("the client verifies against its own base URL and fetch, without the API key", async () => {
    const key = makeKey();
    const { fetch, calls } = mockFetch(jwks([key]));
    const sv = new SplatterVault({ apiKey: KEY, baseUrl: BASE, fetch });
    const token = signToken(key, Math.floor(Date.now() / 1000), { amr: ["studio"] });
    await expect(sv.verifyPlayerToken(token, { gameId: 42 })).resolves.toMatchObject({ sub: PLAYER_ID, amr: ["studio"] });
    await sv.verifyPlayerToken(token, { gameId: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["x-api-key"]).toBeUndefined();
  });
});
