// Signs player tokens the way the API does (Ed25519 compact JWS, kid =
// first 8 bytes of SHA-256("sv player token kid v1\n" || raw public key)), with keys made here.
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

export interface TestKey {
  kid: string;
  x: string;
  privateKey: KeyObject;
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string; kid: string; alg: "EdDSA"; use: "sig" };
}

export function makeKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = String(publicKey.export({ format: "jwk" }).x);
  const kid = createHash("sha256").update(Buffer.from("sv player token kid v1\n", "ascii")).update(Buffer.from(x, "base64url")).digest().subarray(0, 8).toString("hex");
  return { kid, x, privateKey, jwk: { kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig" } };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");

export interface TokenInput {
  game?: number;
  org?: number | null;
  sub?: string;
  amr?: string[];
  app?: string;
  gk?: string;
  iat?: number;
  exp?: number;
  /** Extra or replaced claims (undefined removes one). */
  claims?: Record<string, unknown>;
  /** Extra or replaced header fields. */
  header?: Record<string, unknown>;
}

export const PLAYER_ID = "8f14e45f-ceea-467f-a8f1-2a0e3f5b1c9d";

/** A player token as the API issues it: org game 42 of organization 7 by default, issued at `nowSeconds`. */
export function signToken(key: TestKey, nowSeconds: number, input: TokenInput = {}): string {
  const game = input.game ?? 42;
  const org = input.org === undefined ? 7 : input.org;
  const claims: Record<string, unknown> = {
    iss: "splattervault",
    aud: `sv-player:${game}`,
    sub: input.sub ?? PLAYER_ID,
    scope: org === null ? `game:${game}` : `org:${org}`,
    game,
    gk: input.gk ?? "my-game",
    org,
    amr: input.amr ?? ["steam"],
    ...(input.app !== undefined ? { app: input.app } : input.amr?.[0] === "studio" ? {} : { app: "480" }),
    iat: input.iat ?? nowSeconds,
    exp: input.exp ?? (input.iat ?? nowSeconds) + 3600,
    jti: randomBytes(16).toString("base64url")
  };
  for (const [k, v] of Object.entries(input.claims ?? {})) {
    if (v === undefined) Reflect.deleteProperty(claims, k);
    else claims[k] = v;
  }
  const header: Record<string, unknown> = { alg: "EdDSA", typ: "JWT", kid: key.kid, ...input.header };
  const signingInput = `${b64(header)}.${b64(claims)}`;
  const signature = sign(null, Buffer.from(signingInput, "ascii"), key.privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}
