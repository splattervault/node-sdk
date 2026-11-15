// The checks both consumer smoke tests run against the INSTALLED package (passed in, ESM or CJS).
"use strict";
const assert = require("node:assert/strict");
const { createHash, generateKeyPairSync, randomBytes, sign } = require("node:crypto");

function token(privateKey, kid, now) {
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const claims = {
    iss: "splattervault", aud: "sv-player:42", sub: "8f14e45f-ceea-467f-a8f1-2a0e3f5b1c9d", scope: "org:7", game: 42,
    gk: "my-game", org: 7, amr: ["studio"], iat: now, exp: now + 3600, jti: randomBytes(16).toString("base64url")
  };
  const input = `${b64({ alg: "EdDSA", typ: "JWT", kid })}.${b64(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

module.exports = async function run(sdk, label) {
  const { SplatterVault, SplatterVaultError, PlayerTokenError, verifyPlayerToken, readSessionEnvironment, SDK_VERSION, OPERATIONS } = sdk;
  assert.equal(typeof SplatterVault, "function", `${label}: SplatterVault`);
  assert.match(SDK_VERSION, /^\d+\.\d+\.\d+/);
  assert.equal(Object.keys(OPERATIONS).length, 48);

  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/store/studio/catalog")) {
      return new Response(JSON.stringify({ error: "store_not_enabled", message: "The store is off." }), { status: 404, headers: { "x-request-id": "req-12345678" } });
    }
    return new Response(JSON.stringify({ id: 0, balance: 12.5 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const sv = new SplatterVault({ apiKey: "sv_org_smoke", baseUrl: "http://127.0.0.1:1/rest", fetch });
  const credits = await sv.billing.getCredits();
  assert.equal(credits.balance, 12.5);
  assert.equal(calls[0].url, "http://127.0.0.1:1/rest/credits");
  assert.equal(new Headers(calls[0].init.headers).get("x-api-key"), "sv_org_smoke");

  const err = await sv.store.getCatalog().catch((e) => e);
  assert.ok(err instanceof SplatterVaultError, `${label}: instanceof SplatterVaultError`);
  assert.ok(err instanceof Error);
  assert.equal(err.code, "store_not_enabled");
  assert.equal(err.status, 404);
  assert.equal(err.requestId, "req-12345678");

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = String(publicKey.export({ format: "jwk" }).x);
  const kid = createHash("sha256").update("sv player token kid v1\n").update(Buffer.from(x, "base64url")).digest().subarray(0, 8).toString("hex");
  const keys = { keys: [{ kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig" }] };
  const now = Math.floor(Date.now() / 1000);
  const claims = await verifyPlayerToken(token(privateKey, kid, now), { gameId: 42, keys });
  assert.equal(claims.sub, "8f14e45f-ceea-467f-a8f1-2a0e3f5b1c9d");
  const refused = await verifyPlayerToken(token(privateKey, kid, now), { gameId: 43, keys }).catch((e) => e);
  assert.ok(refused instanceof PlayerTokenError);
  assert.equal(refused.reason, "audience");

  assert.equal(readSessionEnvironment({ SESSION_ID: "7", CODE: "AB", GAME_TYPE: "PPG" }).sessionId, 7);
  console.log(`${label}: ok (${SDK_VERSION})`);
};
