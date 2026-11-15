import { type KeyObject, verify as verifySignature } from "node:crypto";

import { type FetchLike } from "../core/http.js";
import { checkServiceUrl, intInRange, MAX_TIMER_MS, numberInRange } from "../core/validate.js";
import { SDK_VERSION } from "../version.js";
import { importJwks, JwksCache, JwksFetchError, type PlayerTokenJwks } from "./jwks.js";

/** The default API base URL. */
export const DEFAULT_BASE_URL = "https://splattervault.com/rest";

/** Every player token's issuer. */
export const PLAYER_TOKEN_ISSUER = "splattervault";
/** Every player token's audience is this prefix and the game id: `sv-player:42`. */
export const PLAYER_TOKEN_AUDIENCE_PREFIX = "sv-player:";
/** The longest lifetime (exp - iat) of a player token the API issues. */
export const PLAYER_TOKEN_MAX_LIFETIME_SECONDS = 3600;
/** The clock skew the API allows when it checks a player token, and this verifier's default. */
export const PLAYER_TOKEN_CLOCK_SKEW_SECONDS = 30;
const PLAYER_TOKEN_MAX_BYTES = 2048;
/** How long an expired key set may still serve while fetching a new one fails (the API's 5-minute guidance). */
export const DEFAULT_STALE_IF_ERROR_SECONDS = 300;

const KID_RE = /^[0-9a-f]{16}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JTI_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SCOPE_RE = /^(org|game):([1-9][0-9]{0,9})$/;
const APP_ID_RE = /^[\x21-\x7e]{1,64}$/;
const PROVIDER_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_INT32 = 2147483647;
const MAX_GAME_KEY = 255;

/** The sign-in methods the API issues tokens for today (new ones may be added; the verifier accepts any). */
export type PlayerSignInMethod = "xsolla" | "meta" | "steam" | "studio" | "playfab" | "supabase" | "email" | "device";

/** What a verified player token says. Only SplatterVault can have signed it. */
export interface PlayerTokenClaims {
  /** Always `splattervault`. */
  iss: typeof PLAYER_TOKEN_ISSUER;
  /** `sv-player:<game id>`: the game the token is for. */
  aud: `${typeof PLAYER_TOKEN_AUDIENCE_PREFIX}${number}`;
  /** The player's SplatterVault id (uuid): the same player in every game of your organization. */
  sub: string;
  /** Whose players: `org:<organization id>`, or `game:<game id>` for a personal game. */
  scope: `org:${number}` | `game:${number}`;
  /** The game id the token was issued for. */
  game: number;
  /** The game's key when issued ("" when it had none). */
  gk: string;
  /** The game's organization, null for a personal game. */
  org: number | null;
  /** How the player signed in: one method. */
  amr: [PlayerSignInMethod | (string & {})];
  /** The platform app the sign-in proof was checked against (Xsolla project, Meta or Steam app); absent for studio. */
  app?: string;
  /** Issued at (seconds since the epoch). */
  iat: number;
  /** Expires at (seconds since the epoch): about an hour after `iat`. */
  exp: number;
  /** The token's unique id. */
  jti: string;
}

/** Why a player token was refused. */
export type PlayerTokenErrorCode =
  /** Not a genuine, well-formed token for this game. */
  | "token_invalid"
  /** A genuine token past its `exp` (plus the clock tolerance): the player signs in or refreshes again. */
  | "token_expired"
  /** The public keys could not be fetched, so the token could not be checked: try again shortly. */
  | "keys_unavailable";

/**
 * Which check refused the token (for your logs; never shown to players): `malformed`, `header`, `unknown_kid`,
 * `signature`, `issuer`, `claims`, `lifetime`, `not_yet_valid`, `audience` (another game's token), `expired`, `keys`.
 */
export type PlayerTokenFailure =
  | "malformed"
  | "header"
  | "unknown_kid"
  | "signature"
  | "issuer"
  | "claims"
  | "lifetime"
  | "not_yet_valid"
  | "audience"
  | "expired"
  | "keys";

/** A player token that was not accepted. */
export class PlayerTokenError extends Error {
  override readonly name = "PlayerTokenError";
  constructor(
    /** `token_invalid`, `token_expired` or `keys_unavailable`. */
    readonly code: PlayerTokenErrorCode,
    /** Which check failed. */
    readonly reason: PlayerTokenFailure,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

export interface PlayerTokenVerifierOptions {
  /** The games whose tokens to accept (the `aud` must be `sv-player:<one of them>`). Can be given per verify too. */
  gameId?: number | readonly number[];
  /**
   * API base URL (default `https://splattervault.com/rest`); the keys are at `<baseUrl>/player-auth/keys`. https only
   * (http for loopback hosts); redirects are never followed.
   */
  baseUrl?: string;
  /** The JWKS URL, if not under `baseUrl` (same rules as `baseUrl`). */
  jwksUrl?: string;
  /** A fixed key set (a saved `GET /player-auth/keys` answer): nothing is ever fetched. */
  keys?: PlayerTokenJwks;
  /** The `fetch` to use (default: the global one). */
  fetch?: FetchLike;
  /** How long fetching the keys may take, 1 to 2147483647 ms (default 10,000). */
  timeoutMs?: number;
  /** Clock tolerance for `iat` and `exp`, 0 to 300 s (default 30, as the API). */
  clockToleranceSeconds?: number;
  /** The longest `exp - iat` accepted, 1 to 3600 s (default 3600, as the API issues them). */
  maxLifetimeSeconds?: number;
  /** The shortest time between two key fetches caused by an unknown kid or a failed fetch, 0 to 3,600,000 ms (default 10,000). */
  minRefetchIntervalMs?: number;
  /**
   * How long past its lifetime the last key set may still be used while fetching a new one fails, 0 to 3600 s
   * (default 300: the API's own five-minute key-cache guidance). 0 refuses every token (`keys_unavailable`) as soon as
   * a fetch fails after the set expired.
   */
  staleIfErrorSeconds?: number;
  /** Your clock, in ms since the epoch (default `Date.now`). */
  now?: () => number;
  /** Sent as User-Agent when fetching the keys. */
  userAgent?: string;
  /**
   * Allows a plain-http `baseUrl` / `jwksUrl` on a host other than localhost / 127.0.0.1 / [::1]. Keys fetched over
   * plain http can be replaced on the way (anyone in between could then mint player tokens your server accepts):
   * for a development server you trust only.
   */
  dangerouslyAllowInsecureHttp?: boolean;
}

export interface VerifyOptions {
  /** The games whose tokens to accept; overrides the verifier's `gameId`. */
  gameId?: number | readonly number[];
}

function decodeJsonPart(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const positiveInt32 = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= MAX_INT32;

/** Null when the claims hang together as the API issues them, else the first problem. */
function claimsProblem(c: Record<string, unknown>): string | null {
  if (typeof c.sub !== "string" || !UUID_RE.test(c.sub)) return "sub";
  if (typeof c.scope !== "string" || !SCOPE_RE.test(c.scope) || Number(c.scope.split(":")[1]) > MAX_INT32) return "scope";
  if (!positiveInt32(c.game)) return "game";
  if (typeof c.gk !== "string" || c.gk.length > MAX_GAME_KEY) return "gk";
  if (c.org !== null && !positiveInt32(c.org)) return "org";
  const [kind, id] = c.scope.split(":");
  if (kind === "org" ? c.org !== Number(id) : c.org !== null || c.game !== Number(id)) return "scope/org/game";
  // One sign-in method. Its value is not limited to today's list: a method SplatterVault adds later must not make
  // genuine tokens fail in a server that has not updated this SDK.
  if (!Array.isArray(c.amr) || c.amr.length !== 1 || typeof c.amr[0] !== "string" || !PROVIDER_RE.test(c.amr[0])) return "amr";
  if (c.app !== undefined && (c.amr[0] === "studio" || typeof c.app !== "string" || !APP_ID_RE.test(c.app))) return "app";
  return null;
}

function gameList(gameId: number | readonly number[] | undefined): readonly number[] {
  const list = gameId === undefined ? [] : typeof gameId === "number" ? [gameId] : gameId;
  if (list.length === 0) throw new TypeError("gameId is required: the game (or games) whose player tokens to accept");
  for (const g of list) if (!positiveInt32(g)) throw new TypeError("gameId must be a positive integer game id");
  return list;
}

const invalid = (reason: PlayerTokenFailure, message: string) => new PlayerTokenError("token_invalid", reason, message);

/**
 * Verifies SplatterVault player tokens offline, against the public keys from `GET /player-auth/keys` (Ed25519,
 * fetched when needed and kept as long as the answer's Cache-Control allows; fetched again when a token names an
 * unknown key). Use one verifier for the life of your server.
 *
 * It checks what the API itself checks (the signature, `iss`, the claims' shapes, `aud` = `sv-player:<game>`, `iat`
 * and `exp` with a 30-second tolerance, no `nbf`) and that the token is for one of your games. Two differences:
 * - a sign-in method (`amr`) the API adds later is accepted (the signature still proves SplatterVault issued it);
 * - offline, it cannot know what happened after the token was issued: a player erased since, or a game moved to
 *   another owner, still verifies here until the token expires (within the hour), although the API refuses such a
 *   token (`player_deleted`, `token_invalid`). Where that matters, ask the API (e.g. `sv.store.getPlayer(claims.sub)`
 *   answers `player_not_found` for an erased player).
 */
export class PlayerTokenVerifier {
  private readonly cache: JwksCache | null;
  private readonly fixedKeys: Map<string, KeyObject> | null;
  private readonly gameId: number | readonly number[] | undefined;
  private readonly skew: number;
  private readonly maxLifetime: number;
  private readonly now: () => number;

  constructor(options: PlayerTokenVerifierOptions = {}) {
    this.gameId = options.gameId;
    if (options.gameId !== undefined) gameList(options.gameId);
    // Validated here: a NaN tolerance or lifetime would switch the expiry and lifetime checks off.
    this.skew = numberInRange(options.clockToleranceSeconds ?? PLAYER_TOKEN_CLOCK_SKEW_SECONDS, "clockToleranceSeconds", 0, 300);
    this.maxLifetime = intInRange(options.maxLifetimeSeconds ?? PLAYER_TOKEN_MAX_LIFETIME_SECONDS, "maxLifetimeSeconds", 1, 3600);
    if (options.now !== undefined && typeof options.now !== "function") throw new TypeError("now must be a function");
    this.now = options.now ?? Date.now;
    const timeoutMs = intInRange(options.timeoutMs ?? 10_000, "timeoutMs", 1, MAX_TIMER_MS);
    const minRefetchIntervalMs = intInRange(options.minRefetchIntervalMs ?? 10_000, "minRefetchIntervalMs", 0, 3_600_000);
    const staleIfErrorSeconds = numberInRange(options.staleIfErrorSeconds ?? DEFAULT_STALE_IF_ERROR_SECONDS, "staleIfErrorSeconds", 0, 3600);
    if (options.keys) {
      this.fixedKeys = importJwks(options.keys);
      this.cache = null;
      return;
    }
    const fetchFn = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (typeof fetchFn !== "function") throw new TypeError("no fetch: use Node.js 18 or later, or pass { fetch }");
    const insecure = options.dangerouslyAllowInsecureHttp === true;
    const url =
      options.jwksUrl !== undefined
        ? checkServiceUrl(options.jwksUrl, "jwksUrl", insecure)
        : `${checkServiceUrl(options.baseUrl ?? DEFAULT_BASE_URL, "baseUrl", insecure)}/player-auth/keys`;
    this.fixedKeys = null;
    this.cache = new JwksCache({
      url,
      fetch: fetchFn,
      userAgent: options.userAgent ?? `@splattervault/server/${SDK_VERSION}`,
      timeoutMs,
      minRefetchIntervalMs,
      staleIfErrorMs: staleIfErrorSeconds * 1000,
      fallbackMaxAgeMs: 60_000,
      now: this.now
    });
  }

  /**
   * The claims of a valid player token for one of your games; rejects with a {@link PlayerTokenError} otherwise.
   * `claims.sub` is the player's id.
   */
  async verify(token: string, options: VerifyOptions = {}): Promise<PlayerTokenClaims> {
    const games = gameList(options.gameId ?? this.gameId);
    if (typeof token !== "string" || token.length === 0 || token.length > PLAYER_TOKEN_MAX_BYTES) {
      throw invalid("malformed", "not a player token");
    }
    const parts = token.split(".");
    if (parts.length !== 3 || !parts.every((p) => B64URL_RE.test(p))) throw invalid("malformed", "not a player token");
    const [h, p, s] = parts as [string, string, string];

    const header = decodeJsonPart(h);
    if (!header || header.alg !== "EdDSA") throw invalid("header", "the token is not signed with EdDSA");
    if (header.typ !== undefined && header.typ !== "JWT") throw invalid("header", "the token's typ is not JWT");
    if (header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined) {
      throw invalid("header", "the token's header names keys or extensions it may not");
    }
    if (typeof header.kid !== "string" || !KID_RE.test(header.kid)) throw invalid("header", "the token names no valid kid");

    const key = await this.keyFor(header.kid);
    if (!key) throw invalid("unknown_kid", "the token names a key SplatterVault does not publish");

    const signature = Buffer.from(s, "base64url");
    if (signature.length !== 64 || signature.toString("base64url") !== s) throw invalid("signature", "the signature is malformed");
    let ok: boolean;
    try {
      ok = verifySignature(null, Buffer.from(`${h}.${p}`, "ascii"), key, signature);
    } catch {
      ok = false;
    }
    if (!ok) throw invalid("signature", "the signature does not verify");

    const claims = decodeJsonPart(p);
    if (!claims) throw invalid("claims", "the claims are not a JSON object");
    if (claims.iss !== PLAYER_TOKEN_ISSUER || typeof claims.aud !== "string") throw invalid("issuer", "not a SplatterVault player token");
    if (claims.nbf !== undefined) throw invalid("claims", "player tokens carry no nbf");
    if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) throw invalid("claims", "iat and exp must be integers");
    const iat = claims.iat as number;
    const exp = claims.exp as number;
    if (exp <= iat || exp - iat > this.maxLifetime) throw invalid("lifetime", "the token's lifetime is not one the API issues");
    const nowSeconds = Math.floor(this.now() / 1000);
    if (iat > nowSeconds + this.skew) throw invalid("not_yet_valid", "the token was issued in the future (check the server clock)");
    if (typeof claims.jti !== "string" || !JTI_RE.test(claims.jti)) throw invalid("claims", "the token has no valid jti");
    const problem = claimsProblem(claims);
    if (problem) throw invalid("claims", `the token's ${problem} claim is not valid`);
    if (claims.aud !== `${PLAYER_TOKEN_AUDIENCE_PREFIX}${claims.game as number}`) throw invalid("claims", "aud does not name the token's game");
    if (!games.includes(claims.game as number)) throw invalid("audience", "the token is for another game");
    if (nowSeconds > exp + this.skew) throw new PlayerTokenError("token_expired", "expired", "Token expired");
    return claims as unknown as PlayerTokenClaims;
  }

  private async keyFor(kid: string): Promise<KeyObject | null> {
    if (this.fixedKeys) return this.fixedKeys.get(kid) ?? null;
    try {
      return await (this.cache as JwksCache).keyFor(kid);
    } catch (err) {
      if (err instanceof JwksFetchError) {
        throw new PlayerTokenError("keys_unavailable", "keys", `${err.message}; the token could not be checked`, { cause: err });
      }
      throw err;
    }
  }
}

/** A {@link PlayerTokenVerifier}: keep one for the life of your server. */
export function createPlayerTokenVerifier(options: PlayerTokenVerifierOptions = {}): PlayerTokenVerifier {
  return new PlayerTokenVerifier(options);
}

const shared = new Map<string, PlayerTokenVerifier>();
const sharedByFetch = new WeakMap<FetchLike, Map<string, PlayerTokenVerifier>>();

/**
 * Verifies a player token offline and answers its claims (`claims.sub` is the player's id); rejects with a
 * {@link PlayerTokenError} otherwise. The keys are cached per JWKS URL (and `fetch`) across calls; for other settings
 * than `gameId`, `baseUrl`, `jwksUrl`, `fetch` or `keys`, keep a verifier from {@link createPlayerTokenVerifier}.
 *
 * ```ts
 * const claims = await verifyPlayerToken(token, { gameId: 42 });
 * console.log(`player ${claims.sub} joined`);
 * ```
 */
export function verifyPlayerToken(
  token: string,
  options: { gameId: number | readonly number[] } & Pick<
    PlayerTokenVerifierOptions,
    "baseUrl" | "jwksUrl" | "fetch" | "keys" | "dangerouslyAllowInsecureHttp"
  >
): Promise<PlayerTokenClaims> {
  if (options.keys) return new PlayerTokenVerifier({ keys: options.keys }).verify(token, { gameId: options.gameId });
  const insecure = options.dangerouslyAllowInsecureHttp === true;
  const url =
    options.jwksUrl !== undefined
      ? checkServiceUrl(options.jwksUrl, "jwksUrl", insecure)
      : `${checkServiceUrl(options.baseUrl ?? DEFAULT_BASE_URL, "baseUrl", insecure)}/player-auth/keys`;
  let byUrl = shared;
  if (options.fetch) {
    byUrl = sharedByFetch.get(options.fetch) ?? new Map();
    sharedByFetch.set(options.fetch, byUrl);
  }
  let verifier = byUrl.get(url);
  if (!verifier) {
    verifier = new PlayerTokenVerifier({ jwksUrl: url, dangerouslyAllowInsecureHttp: insecure, ...(options.fetch ? { fetch: options.fetch } : {}) });
    byUrl.set(url, verifier);
  }
  return verifier.verify(token, { gameId: options.gameId });
}
