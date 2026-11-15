import { createPublicKey, type KeyObject } from "node:crypto";

import { type FetchLike } from "../core/http.js";

/** One public key of the player-token JWKS (`GET /player-auth/keys`). */
export interface PlayerTokenJwk {
  kty: "OKP";
  crv: "Ed25519";
  /** base64url of the raw 32-byte Ed25519 public key. */
  x: string;
  /** 16 hex characters; a token's header names it. */
  kid: string;
  alg?: "EdDSA";
  use?: "sig";
}

/** The JWKS `GET /player-auth/keys` answers: the current key and, during a rotation, the next and previous ones. */
export interface PlayerTokenJwks {
  keys: PlayerTokenJwk[];
}

const KID_RE = /^[0-9a-f]{16}$/;
/** The shortest time a fetched key set is kept (whatever its Cache-Control says). */
export const MIN_KEYS_LIFETIME_MS = 60_000;
/** The longest time a fetched key set is kept (whatever its Cache-Control says). */
export const MAX_KEYS_LIFETIME_MS = 3_600_000;
const X_RE = /^[A-Za-z0-9_-]{43}$/;

/** The usable Ed25519 keys of a JWKS, by kid. Keys of another kind (or malformed ones) are skipped, never fatal. */
export function importJwks(jwks: unknown): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const list = (jwks as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) throw new Error("not a JWKS: no keys array");
  for (const jwk of list as unknown[]) {
    if (!jwk || typeof jwk !== "object") continue;
    const k = jwk as Record<string, unknown>;
    if (k.kty !== "OKP" || k.crv !== "Ed25519") continue;
    if (k.alg !== undefined && k.alg !== "EdDSA") continue;
    if (k.use !== undefined && k.use !== "sig") continue;
    if (typeof k.kid !== "string" || !KID_RE.test(k.kid)) continue;
    if (typeof k.x !== "string" || !X_RE.test(k.x)) continue;
    const raw = Buffer.from(k.x, "base64url");
    if (raw.length !== 32 || raw.toString("base64url") !== k.x) continue;
    try {
      keys.set(k.kid, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" }));
    } catch {
      /* not a usable Ed25519 key: skipped */
    }
  }
  return keys;
}

/**
 * How long an answer may be used without fetching again, in ms, from its `Cache-Control` and `Age`: `max-age` minus
 * `Age`; 0 for `no-store` / `no-cache`; `fallbackMs` when the answer names no lifetime.
 */
export function freshnessMs(cacheControl: string | null, age: string | null, fallbackMs: number): number {
  if (cacheControl === null || cacheControl.trim() === "") return fallbackMs;
  const directives = cacheControl.toLowerCase().split(",").map((d) => d.trim());
  if (directives.some((d) => d === "no-store" || d === "no-cache" || d.startsWith("no-cache="))) return 0;
  const maxAge = directives.find((d) => d.startsWith("max-age="));
  if (!maxAge) return fallbackMs;
  const seconds = Number(maxAge.slice("max-age=".length).replace(/^"|"$/g, ""));
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  const ageSeconds = age !== null && /^\d+$/.test(age.trim()) ? Number(age.trim()) : 0;
  return Math.max(0, seconds - ageSeconds) * 1000;
}

export interface JwksCacheOptions {
  url: string;
  fetch: FetchLike;
  userAgent: string;
  timeoutMs: number;
  /** The shortest time between two fetches caused by an unknown kid. */
  minRefetchIntervalMs: number;
  /** How long past its lifetime a key set may still be used while fetching a new one fails. */
  staleIfErrorMs: number;
  /** The lifetime of an answer that names none in Cache-Control. */
  fallbackMaxAgeMs: number;
  now: () => number;
}

/** Why the key set could not be fetched; the cause carries the details. */
export class JwksFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JwksFetchError";
  }
}

interface CachedSet {
  keys: Map<string, KeyObject>;
  freshUntil: number;
  staleUntil: number;
}

/**
 * The player-token keys, fetched on demand and kept as long as the answer's `Cache-Control` allows (at least
 * max(minRefetchIntervalMs, 60 s), at most an hour); fetched again (single-flight, at most once per
 * `minRefetchIntervalMs`) when a token names a kid the set does not hold. After a failed fetch, no new fetch for
 * `minRefetchIntervalMs`.
 */
export class JwksCache {
  private cached: CachedSet | null = null;
  private inflight: Promise<CachedSet> | null = null;
  private lastFetchStart = Number.NEGATIVE_INFINITY;
  private lastFailure = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: JwksCacheOptions) {}

  /** The key of `kid`, or null when the (refreshed) set has none. Throws JwksFetchError when no usable set exists. */
  async keyFor(kid: string): Promise<KeyObject | null> {
    const now = this.options.now();
    const cached = this.cached;
    if (cached && now < cached.freshUntil) {
      const key = cached.keys.get(kid);
      if (key) return key;
      if (now - this.lastFetchStart < this.options.minRefetchIntervalMs) return null;
      return (await this.refresh()).keys.get(kid) ?? null;
    }
    // Past its lifetime (or never fetched): fetch again, unless a fetch failed a moment ago. Then the old set serves
    // while it may, else the failure stands without another fetch (no fetch per verification while the API is down).
    if (now - this.lastFailure < this.options.minRefetchIntervalMs) {
      if (cached && now < cached.staleUntil) return cached.keys.get(kid) ?? null;
      throw new JwksFetchError("the player token keys could not be fetched a moment ago; not trying again yet");
    }
    try {
      return (await this.refresh()).keys.get(kid) ?? null;
    } catch (err) {
      this.lastFailure = this.options.now();
      const stale = this.cached;
      if (stale && this.lastFailure < stale.staleUntil) return stale.keys.get(kid) ?? null;
      throw err;
    }
  }

  /** Fetches the set now (joining a fetch already under way). */
  refresh(): Promise<CachedSet> {
    if (this.inflight) return this.inflight;
    this.lastFetchStart = this.options.now();
    const p = this.fetchSet().finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  private async fetchSet(): Promise<CachedSet> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await this.options.fetch(this.options.url, {
        method: "GET",
        headers: { Accept: "application/json", "Cache-Control": "no-cache", "User-Agent": this.options.userAgent },
        // Never followed: keys from wherever a redirect points would be trusted to sign player tokens.
        redirect: "manual",
        signal: controller.signal
      });
      text = await res.text();
    } catch (err) {
      throw new JwksFetchError(`could not fetch the player token keys: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
    if (res.status !== 200) {
      let code = "";
      try {
        const body = JSON.parse(text) as { error?: unknown };
        if (typeof body?.error === "string") code = ` ${body.error}`;
      } catch {
        /* not JSON */
      }
      const redirect = res.status >= 300 && res.status < 400 ? " (a redirect, which is never followed)" : "";
      throw new JwksFetchError(`the player token keys answered HTTP ${res.status}${code}${redirect}`);
    }
    let keys: Map<string, KeyObject>;
    try {
      keys = importJwks(JSON.parse(text));
    } catch (err) {
      throw new JwksFetchError("the player token keys answer is not a JWKS", { cause: err });
    }
    const fetchedAt = this.options.now();
    // Kept at least max(minRefetchIntervalMs, 60 s), even for no-store (else every verification would fetch), and at
    // most an hour (a key SplatterVault stops publishing is not trusted much longer, whatever the answer said).
    const floor = Math.max(this.options.minRefetchIntervalMs, MIN_KEYS_LIFETIME_MS);
    const named = freshnessMs(res.headers.get("cache-control"), res.headers.get("age"), this.options.fallbackMaxAgeMs);
    const lifetime = Math.min(Math.max(named, floor), MAX_KEYS_LIFETIME_MS);
    const set: CachedSet = { keys, freshUntil: fetchedAt + lifetime, staleUntil: fetchedAt + lifetime + this.options.staleIfErrorMs };
    this.cached = set;
    return set;
  }
}
