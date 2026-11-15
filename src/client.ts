import { type FetchLike, HttpClient, MAX_RETRIES } from "./core/http.js";
import { DEFAULT_RETRY, type RetrySettings } from "./core/retry.js";
import { checkServiceUrl, intInRange, MAX_TIMER_MS } from "./core/validate.js";
import { PlayerTokenVerifier, DEFAULT_BASE_URL, type PlayerTokenClaims, type VerifyOptions } from "./playerToken/verify.js";
import { Billing } from "./resources/billing.js";
import { PlayerData } from "./resources/playerData.js";
import { Players } from "./resources/players.js";
import { Games, ServerPools, Sessions } from "./resources/sessions.js";
import { Store } from "./resources/store.js";
import { SDK_VERSION } from "./version.js";

export interface SplatterVaultOptions {
  /**
   * Your organization API key (`sv_org_...`), holding the permissions of the calls you make. Default:
   * `process.env.SV_API_KEY`. Keep it on your servers: never in a game build or a web page.
   */
  apiKey?: string;
  /**
   * The API base URL. Default `https://splattervault.com/rest`. https only (plain http only for localhost, 127.0.0.1
   * or [::1], e.g. a local mock); no credentials, query or fragment. The SDK never follows redirects.
   */
  baseUrl?: string;
  /** The `fetch` to call (default: the global one, Node.js 18+). Tests and proxies can pass their own. */
  fetch?: FetchLike;
  /** Retries after the first attempt, for calls that are safe to repeat: 0 to 20 (default 2). 0 turns retries off. */
  maxRetries?: number;
  /**
   * How long one attempt may take in ms, answer included: 1 to 2147483647 (default 30,000). Slow operations (creating
   * or claiming servers: 60 s; imports: 120 s) get at least their own default.
   */
  timeoutMs?: number;
  /** Prefixed to the SDK's User-Agent, e.g. `my-matchmaker/2.1`. */
  userAgent?: string;
  /** Waits between retries, each 0 to 2147483647 ms. */
  retry?: Partial<Pick<RetrySettings, "baseDelayMs" | "maxDelayMs" | "maxRetryAfterMs">>;
  /**
   * The SDK refuses to start in a browser, a web worker, React Native, Electron or NW.js: an organization API key in
   * anything you ship to players is readable by them. Set this only for a trusted environment that merely looks like
   * one (e.g. a test runner with a DOM, an internal Electron tool). Game clients use a game-client SDK and player
   * tokens instead.
   */
  dangerouslyAllowBrowser?: boolean;
  /**
   * Allows a plain-http `baseUrl` on a host other than localhost / 127.0.0.1 / [::1]. Your API key would travel
   * unencrypted: for a development server on a network you trust only.
   */
  dangerouslyAllowInsecureHttp?: boolean;
}

/**
 * True in a browser, a web worker, React Native, or an app shell that ships to players: Electron (main process and
 * renderer) and NW.js.
 */
export function isBrowserLike(): boolean {
  const g = globalThis as Record<string, unknown> & { navigator?: { product?: string } };
  const versions = (typeof process !== "undefined" ? process.versions : undefined) as Record<string, string | undefined> | undefined;
  if (versions?.electron !== undefined || versions?.nw !== undefined) return true;
  const win = g.window as { document?: unknown } | undefined;
  if (win !== undefined && win !== null && typeof win === "object" && win.document !== undefined) return true;
  if (typeof g.importScripts === "function") return true;
  const workerScope = g.WorkerGlobalScope as (abstract new () => unknown) | undefined;
  if (typeof workerScope === "function" && globalThis instanceof workerScope) return true;
  if (g.navigator?.product === "ReactNative") return true;
  return false;
}

const API_KEY_RE = /^[\x21-\x7e]+$/;

/**
 * The SplatterVault server client: one per process, for your game backend and game servers.
 *
 * ```ts
 * import { SplatterVault } from "@splattervault/server";
 *
 * const sv = new SplatterVault({ apiKey: process.env.SV_API_KEY });
 * const session = await sv.sessions.create({ gameTypeConfigKey: "my-game", region: "NYC3" });
 * ```
 */
export class SplatterVault {
  /** Game-server sessions billed in credits (and `sessions.subscription` for subscription-billed ones). */
  readonly sessions: Sessions;
  /** Warm server pools: claim a running server for a match. */
  readonly serverPools: ServerPools;
  /** Game types: the launch arguments a session may set. */
  readonly games: Games;
  /** Credits, subscriptions and usage. */
  readonly billing: Billing;
  /** Studio player sign-in from your backend: sign in with your own ids, import, erase. */
  readonly players: Players;
  /** Each player's data and the game's data. */
  readonly playerData: PlayerData;
  /** The store: catalog, holdings, grants, consumes, purchases, reversals, imports. */
  readonly store: Store;

  readonly #http: HttpClient;
  readonly #insecureHttp: boolean;
  #verifier: PlayerTokenVerifier | null = null;

  constructor(options: SplatterVaultOptions = {}) {
    if (isBrowserLike() && options.dangerouslyAllowBrowser !== true) {
      throw new Error(
        "@splattervault/server refuses to run in a browser-like environment (a browser, a web worker, React Native, " +
          "Electron or NW.js): an organization API key there is readable by anyone who has the page or the app. Call " +
          "SplatterVault from your server; game clients sign players in and use player tokens. If this environment is " +
          "trusted and only looks like one, pass { dangerouslyAllowBrowser: true }."
      );
    }
    const apiKey = options.apiKey ?? (typeof process !== "undefined" ? process.env?.SV_API_KEY : undefined);
    if (typeof apiKey !== "string" || apiKey === "") {
      throw new TypeError("apiKey is required: pass { apiKey } or set SV_API_KEY (an organization API key, sv_org_...)");
    }
    if (!API_KEY_RE.test(apiKey)) throw new TypeError("apiKey must be visible ASCII characters only (check for spaces or line breaks)");
    const fetchFn = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (typeof fetchFn !== "function") throw new TypeError("no fetch: use Node.js 18 or later, or pass { fetch }");
    this.#insecureHttp = options.dangerouslyAllowInsecureHttp === true;
    const baseUrl = checkServiceUrl(options.baseUrl ?? DEFAULT_BASE_URL, "baseUrl", this.#insecureHttp);
    // Numbers are checked here: NaN retries would never stop, and a timer past 2^31-1 ms fires after 1 ms.
    const timeoutMs = intInRange(options.timeoutMs ?? 30_000, "timeoutMs", 1, MAX_TIMER_MS);
    const maxRetries = intInRange(options.maxRetries ?? DEFAULT_RETRY.maxRetries, "maxRetries", 0, MAX_RETRIES);
    const retry: RetrySettings = { ...DEFAULT_RETRY, maxRetries };
    for (const name of ["baseDelayMs", "maxDelayMs", "maxRetryAfterMs"] as const) {
      const value = options.retry?.[name];
      if (value !== undefined) retry[name] = intInRange(value, `retry.${name}`, 0, MAX_TIMER_MS);
    }
    const sdkAgent = `splattervault-server-node/${SDK_VERSION} node/${typeof process !== "undefined" ? process.version : "unknown"}`;

    this.#http = new HttpClient({
      apiKey,
      baseUrl,
      fetch: fetchFn,
      timeoutMs,
      retry,
      userAgent: options.userAgent ? `${options.userAgent} ${sdkAgent}` : sdkAgent
    });
    this.sessions = new Sessions(this.#http);
    this.serverPools = new ServerPools(this.#http);
    this.games = new Games(this.#http);
    this.billing = new Billing(this.#http);
    this.players = new Players(this.#http);
    this.playerData = new PlayerData(this.#http);
    this.store = new Store(this.#http);
  }

  /** The API base URL this client calls. */
  get baseUrl(): string {
    return this.#http.baseUrl;
  }

  /**
   * Verifies a player's token offline (Ed25519, against `GET /player-auth/keys` of this client's base URL, cached as
   * the answer's Cache-Control allows) and answers its claims: `claims.sub` is the player's id. Rejects with a
   * `PlayerTokenError` (`token_invalid`, `token_expired` or `keys_unavailable`). The API key is not sent.
   *
   * ```ts
   * const { sub: playerId } = await sv.verifyPlayerToken(tokenFromClient, { gameId: 42 });
   * ```
   */
  verifyPlayerToken(token: string, options: VerifyOptions & { gameId: number | readonly number[] }): Promise<PlayerTokenClaims> {
    this.#verifier ??= new PlayerTokenVerifier({
      baseUrl: this.#http.baseUrl,
      fetch: this.#http.fetchFn,
      dangerouslyAllowInsecureHttp: this.#insecureHttp
    });
    return this.#verifier.verify(token, options);
  }

  /** Never shows the API key. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `SplatterVault { baseUrl: '${this.#http.baseUrl}' }`;
  }

  /** Never shows the API key. */
  toJSON(): { baseUrl: string } {
    return { baseUrl: this.#http.baseUrl };
  }
}
