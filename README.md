# @splattervault/server

The SplatterVault SDK for your **game backend and game servers** (Node.js 18+, TypeScript types included, no
runtime dependencies).

- **Game servers**: start a dedicated server for a match, or claim a warm one from a pool in seconds; stop, rename,
  reschedule; credits and subscriptions.
- **Players**: sign players in with your own ids, import players from other systems, erase a player and everything
  kept about them.
- **Player data**: read and write each player's data and your game's data, with versions for safe concurrent changes.
- **Store**: grant, consume, buy with virtual currency and reverse, each applied exactly once; catalog and holdings
  imports.
- **Player tokens**: verify, offline, that a player connecting to your game server really signed in to SplatterVault.

> **Preview (0.x).** The API surface may still change between minor versions; see the [CHANGELOG](CHANGELOG.md).

## Your API key stays on your servers

This SDK calls the Studio API with an **organization API key** (`sv_org_...`). Anyone who holds that key can act as
your studio: grant items, read and erase players, start servers billed to you. So:

- Put the key only on your backend and game servers (an environment variable or your secret manager). **Never in a
  game build, a web page or a mobile app**, never in a repository.
- The SDK refuses to start in a browser, a web worker, React Native, Electron or NW.js (anything you ship to players),
  and it never logs or prints the key (not even in `console.log(sv)` or in errors).
- The key only travels over https to the URL you configured: the SDK refuses a plain-http `baseUrl` except for
  localhost / 127.0.0.1 / [::1] (a local mock), and it **never follows a redirect** (a 3xx is an error with code
  `redirect_not_followed`), so the key is never sent to another address.
- Give each key only the permissions it needs (console → your organization → API keys), and rotate it if it leaks.

Game clients do not use this SDK. They sign their player in (Steam, Meta, email, a guest, your own backend…) and call
the player routes with a short-lived **player token**, using the SDK of their engine:
[Unity](https://github.com/splattervault/unity-sdk), [Unreal](https://github.com/splattervault/unreal-sdk) or
[Godot](https://github.com/splattervault/godot-sdk).

## Install

```sh
npm install @splattervault/server
```

Works from ESM (`import`) and CommonJS (`require`), on Node.js 18, 20, 22 and later. Both load the same single copy of
the SDK (the ES module entry re-exports the CommonJS build), so `instanceof SplatterVaultError` holds whichever way an
error was created.

## Quick start

```ts
import { SplatterVault } from "@splattervault/server";

const sv = new SplatterVault({ apiKey: process.env.SV_API_KEY });
// With no apiKey option, the SDK reads SV_API_KEY itself.
```

One client per process is enough; it is safe to share.

### Give a match a dedicated server

Claim a warm server from one of your pools (it is already running: seconds), or start a new session (about a
minute):

```ts
import { SplatterVault, SplatterVaultError } from "@splattervault/server";

const sv = new SplatterVault();

async function serverForMatch(matchId: string) {
  try {
    const claim = await sv.serverPools.claim(12, { friendlyName: `Match ${matchId}`, mode: "Ranked" });
    return claim; // { sessionId, serverInstanceId, connection: { host, primaryPort, code, ... } | null }
  } catch (err) {
    // 409: no warm server free right now: start a new one instead.
    if (!(err instanceof SplatterVaultError) || err.status !== 409) throw err;
  }
  const session = await sv.sessions.create({
    gameTypeConfigKey: "my-game",
    region: "NYC3",
    friendlyName: `Match ${matchId}`,
    idleTimeoutMinutes: 15 // stops itself 15 minutes after the last player leaves
  });
  // "Pending" until the server is up: wait until the game says it is ready (up to 5 minutes by default).
  const ready = await sv.sessions.waitUntilReady(session.id);
  return { sessionId: ready.id, connection: ready.connection ?? null };
}

// When the match is over:
const { totalCost } = await sv.sessions.stop(sessionId); // credits billed for this session
```

`waitUntilReady` polls the session with a growing interval (2 s, then up to 10 s) until it is Active and its game
says it is ready (`ready: true`; a game with no ready signal is returned once its `readyDeadlineAt` passes, with
`ready: false`; `{ waitForGameReady: false }` returns as soon as it is Active). It rejects with a `SessionWaitError`:
`session_ended` (with `sessionStatus` and `stopReason`, e.g. `GAME_CRASH`) or `wait_timeout` (`timeoutMs`, default
5 minutes), and honours `signal`.

Creating a session, stopping one and claiming a pool server are **never retried by the SDK** (a repeat could start or
claim a second server). After a network error, look for the session with `sv.sessions.list()` before trying again.

### Verify a player's token on your game server

The game client sends its player token when it connects; your server checks it **offline** against SplatterVault's
public keys (Ed25519; fetched once, then cached as long as the API's `Cache-Control` allows, and fetched again when a
token names a new key):

```ts
import { createPlayerTokenVerifier, PlayerTokenError } from "@splattervault/server";

const verifier = createPlayerTokenVerifier({ gameId: 42 }); // one for the life of the server

async function onConnect(token: string) {
  try {
    const claims = await verifier.verify(token);
    return claims.sub; // the player's SplatterVault id
  } catch (err) {
    if (err instanceof PlayerTokenError) {
      // token_expired: the client refreshes its token and connects again
      // keys_unavailable: SplatterVault could not be reached to fetch the keys: try again shortly
      // token_invalid: refuse (err.reason says which check failed, for your logs)
    }
    throw err;
  }
}
```

It checks what the API itself checks: the signature, `iss` = `splattervault`, `aud` = `sv-player:<your game id>`
(a token for another of your games is refused), `iat` and `exp` with 30 seconds of clock tolerance, no `nbf`, and the
shape of every claim. Verifying needs no API key (the keys are public), so it also works in a game server that holds
none. With a client at hand: `await sv.verifyPlayerToken(token, { gameId: 42 })`; or the one-off
`verifyPlayerToken(token, { gameId: 42 })`.

What offline verification cannot know:

- **Erased players and changed owners.** The API refuses a token whose player was erased since it was issued
  (`player_deleted`), or whose game moved to another owner (`token_invalid`). Offline, such a token still verifies
  until it expires (at most an hour). Where it matters, ask the API: `sv.store.getPlayer(claims.sub)` answers
  `player_not_found` for an erased player.
- **New sign-in methods.** `claims.amr` holds one sign-in method; a method SplatterVault adds after this SDK version is
  accepted too (the signature still proves SplatterVault issued the token), where the API's own list is closed.

The keys are cached as the answer's `Cache-Control` says, but at least 60 seconds and at most an hour; while
SplatterVault cannot be reached, the last keys keep working for `staleIfErrorSeconds` (default 300) after they
expired, and a failed fetch is not tried again for 10 seconds.

### Grant a store item

```ts
const result = await sv.store.grant(
  playerId, // a SplatterVault player id, or "steam:7656...", "studio:<your id>", ...
  { lines: [{ sku: "trophy_s3", quantity: 1 }, { currency: "GOLD", amount: 100 }], reason: "Season 3 reward" },
  { idempotencyKey: `season3:${playerId}` } // optional: see "Exactly once" below
);
console.log(result.replayed, result.balances);
```

`consume`, `purchase` (with `expectedPrice`), `updateItem` and `reverse` work the same way.

**Exactly once.** Every store change carries an `Idempotency-Key`. By default the SDK makes one per call and sends
the same one, with the same body, on its own retries, so a lost answer never applies a change twice. To stay
exactly-once across your own retries and process restarts too, pass a key derived from your own record
(`reward:${matchId}:${playerId}`): the same key and request again answers the first result with `replayed: true`; the
same key with a different request is `409 idempotency_conflict`.

When a change fails with `err.outcomeUnknown` (no answer, or a 500/502/504, even after the SDK's own retries), it may
have been applied. Send it again **with the same key** (`{ idempotencyKey: err.idempotencyKey }`, the same body), at
once or from a "Retry" button: never call `grant` or `purchase` again without the key, which could apply it twice.

### Write player data

```ts
// Read, then change only what you read (ifVersion): a concurrent change makes it fail with version_conflict.
const { data } = await sv.playerData.get(42, playerId, { stores: ["readonly"], keys: ["settings"] });
const settings = data.readonly?.settings;
await sv.playerData.update(42, playerId, {
  ops: [{ op: "set", store: "readonly", key: "settings", value: { music: false }, ifVersion: settings?.version ?? 0 }]
});

// A counter: no read needed (never sent twice by the SDK; after an unknown outcome you cannot tell if it counted).
await sv.playerData.update(42, playerId, { ops: [{ op: "inc", store: "readonly", key: "xp", by: 50 }] });

// Your game's own data; players read "public" within 30 seconds.
await sv.playerData.updateGameData(42, { ops: [{ op: "set", store: "public", key: "motd", value: "Season 3 is live" }] });
```

Stores: a player's `player` (the game client may write it), `readonly` (only your backend writes it) and `internal`
(players never see it); a game's `public` and `internal`. Writes are all or nothing. `stores` and `keys` may be left
out (everything) but not empty.

**When the answer is lost.** A write that got no answer, a timeout, a 500, 502 or 504 may or may not have been
applied: the error has `outcomeUnknown: true`, and the SDK does not send it again (even with `ifVersion`: the second
send could meet the first one's own new version). The same goes for a write the SDK did resend (only ever after a 408,
429 or 503, which prove nothing was applied) that then meets `version_conflict`: it is reported as code
`outcome_unknown`, never as a plain conflict. To recover, read the key again: if its version moved and the value is
the one you wrote, your write was applied. Never just apply your change again on top. A value that carries its own
mark makes this easy (see `recordWin` in [examples/rewards.ts](examples/rewards.ts), which keeps the ids of the
matches it counted).

### Sign players in from your backend

Use your own accounts and still give players SplatterVault tokens (store, player data):

```ts
const { token, expiresAt, player } = await sv.players.signIn({ gameId: 42, externalId: "user-981", displayName: "Nova" });
// Send token to the game client. The same externalId is always the same player (player.id).
```

## Errors

Every refusal is a `SplatterVaultError`:

```ts
import { SplatterVaultError } from "@splattervault/server";

try {
  await sv.store.purchase(playerId, { sku: "sword", currency: "GOLD", expectedPrice: 250 });
} catch (err) {
  if (err instanceof SplatterVaultError) {
    switch (err.code) {
      case "insufficient_funds": /* tell the player */ break;
      case "price_changed": /* show the new price */ break;
      default: throw err;
    }
  }
}
```

| Field | What it is |
|---|---|
| `code` | The API's stable `error` code (`insufficient_funds`, `version_conflict`, `rate_limited`, `player_not_found`…). **Key your handling on it.** The set is open: handle an unknown code by `status`. Null for the session and billing routes' refusals, which have no code (see `errorName`). SDK codes: `network_error`, `timeout`, `aborted` (status 0); `invalid_response`, `redirect_not_followed`, `outcome_unknown` (with the answer's status). |
| `status` | The HTTP status; 0 when no answer arrived. |
| `message` | `"<code> (HTTP <status>): <the API's sentence>"`: for logs, not for parsing. |
| `details` | More about some refusals, e.g. `version_conflict`: `[{ store, key, version }]`; `limit_exceeded`: `{ limit, max }`; `banned`: `{ type, scopes }`. |
| `retryAfter` | The answer's `Retry-After`, in seconds, or null. |
| `requestId` | The answer's `x-request-id`: quote it when you contact support. |
| `errorName`, `errors` | The session and billing routes' `{ name, errors }` (e.g. `BAD_REQUEST`). |
| `outcomeUnknown` | True when a write may or may not have been applied (no answer, 500/502/504, an abort mid-send, a resent `ifVersion` write that met a conflict). Always false for reads. |
| `idempotencyKey` | The `Idempotency-Key` a store change was sent with (yours or the SDK's): send the change again with it to settle an unknown outcome. |
| `operationId`, `method`, `path`, `attempts`, `body` | What failed, and how many times it was sent. |

`err.is("rate_limited")`, `err.isTransient` (408, 429, 500, 502, 503, 504 or no answer) and `err.isNetworkError` help too. Each
operation's codes are listed in the [Studio API reference](https://splattervault.com/docs/studio).

## Retries, timeouts and cancellation

The SDK sends a request again by itself only when that is **safe**, and only after a transient failure: no answer
(network error or timeout), or HTTP 408, 429, 500, 502, 503 or 504. Never after another 4xx or a redirect.

| Retried after any transient failure | Retried only after 408, 429, 503 | Not retried (a repeat could act twice) |
|---|---|---|
| Every read (GET) | Player-data writes whose every op has `ifVersion` (see "When the answer is lost") | Creating, stopping, renaming, rescheduling or cancelling a session |
| Store changes (same `Idempotency-Key` and body each time) | | Claiming a pool server |
| Lookups (`playerData.resolve`, `playerData.getMany`) and `playerData.clear` | | Player-data writes without `ifVersion` (e.g. `inc`) |
| Imports (the same rows again change nothing) | | Studio sign-in, erasing a player, the Meta purchase check |

A resent store change that meets `409 idempotency_conflict` can only be meeting its own first send still in progress
(same key, same body), so it is retried too.

- Up to `maxRetries` retries (default 2, at most 20), with exponential backoff and jitter (0.5 s, 1 s, … up to 8 s).
- A `Retry-After` is always honoured, never shortened. One longer than `retry.maxRetryAfterMs` (default 10 s) is not
  waited out: the error is thrown with `retryAfter` set, for you to schedule.
- `timeoutMs` (default 30 s, 1 ms to 2147483647 ms) bounds each attempt, answer included. Creating or claiming servers
  gets at least 60 s, imports at least 120 s.
- Numeric options are checked when you set them: NaN, Infinity or out-of-range values throw a `RangeError`.
- Every method takes options last: `{ signal, timeoutMs, maxRetries, headers }` (and `idempotencyKey` for store
  changes). An aborted `signal` ends the call at once, also during a wait, with code `aborted`.

```ts
const sv = new SplatterVault({ maxRetries: 3, timeoutMs: 10_000, retry: { maxRetryAfterMs: 30_000 } });
await sv.billing.getOrgCredits({}, { signal: AbortSignal.timeout(5000) });
```

## Pages

```ts
// A player's store history, newest first, 50 a page.
for await (const page of sv.store.historyPages(playerId)) {
  for (const txn of page.txns) console.log(txn.kind, txn.createdAt);
}

// Erased players, for deleting what YOUR database keeps about them. Save `next` after each page; poll every few minutes.
for await (const page of sv.playerData.erasedPlayerPages(savedCursor ? { cursor: savedCursor } : { since: "2026-11-01T00:00:00Z" })) {
  await deleteFromMyDatabase(page.players.map((p) => p.id));
  savedCursor = page.next;
}
```

## On a SplatterVault game server

A game process that SplatterVault starts gets a few session variables (never the server's own credentials):

```ts
import { readSessionEnvironment } from "@splattervault/server";

const env = readSessionEnvironment(); // reads process.env
// { onSplatterVault, sessionId, code, gameType, mode, serverName, friendlyName, buildChannel, slavePort }
```

On a server of its own (a session you created), `sessionId` is the session's id. On a **pool** server `sessionId` is
null (the claim does not set it: use the `sessionId` that `serverPools.claim()` answered) and only `code` is the
claiming match's; `mode`, `serverName` and `friendlyName` are from when the pool server booted.

## API

| Namespace | Methods |
|---|---|
| `sv.sessions` | `create`, `list`, `get`, `waitUntilReady`, `listMine`, `stop`, `rename`, `reschedule`, `cancelSchedule` |
| `sv.sessions.subscription` | `create`, `list`, `stop`, `rename`, `reschedule`, `cancelSchedule` (subscription-billed) |
| `sv.serverPools` | `claim` |
| `sv.games` | `getConfigurableArgs` |
| `sv.billing` | `getCredits`, `getCreditStats`, `getOrgCredits`, `getOrgSubscriptions`, `getOrgCreditsById`, `getOrgSubscriptionById`, `getSubscriptions`, `getUsage` |
| `sv.players` | `signIn`, `import`, `erase` |
| `sv.playerData` | `resolve`, `get`, `update`, `clear`, `getMany`, `writeMany`, `getGameData`, `updateGameData`, `import`, `listErasedPlayers`, `erasedPlayerPages` |
| `sv.store` | `getCatalog`, `getPlayer`, `getHistory`, `historyPages`, `grant`, `consume`, `purchase`, `updateItem`, `reverse`, `syncMetaPurchases`, `importCatalog`, `importHoldings` |
| `sv` | `verifyPlayerToken` |
| functions | `verifyPlayerToken`, `createPlayerTokenVerifier`, `readSessionEnvironment`, `newIdempotencyKey` |

Each method's documentation names its API operation (`@see POST /store/studio/players/{player}/grants`). Request and
answer types (`ServerSession`, `StoreTxnResult`, `DataOp`, …) are exported, generated from the API's OpenAPI
description; `Schemas`, `components`, `operations` and `paths` hold all of them.

Options of `new SplatterVault(options)`:

| Option | Default | |
|---|---|---|
| `apiKey` | `process.env.SV_API_KEY` | Your organization API key. |
| `baseUrl` | `https://splattervault.com/rest` | https only; http for localhost / 127.0.0.1 / [::1]. |
| `fetch` | `globalThis.fetch` | Any `fetch`-compatible function (proxies, tests). |
| `maxRetries` | `2` | Retries after the first attempt (safe calls only). |
| `timeoutMs` | `30000` | Per attempt. |
| `retry` | `{ baseDelayMs: 500, maxDelayMs: 8000, maxRetryAfterMs: 10000 }` | |
| `userAgent` | | Prefixed to the SDK's User-Agent. |
| `dangerouslyAllowBrowser` | `false` | See "Your API key stays on your servers". |
| `dangerouslyAllowInsecureHttp` | `false` | Allows a plain-http `baseUrl` on another host (the key travels unencrypted). |

### Testing your code

Pass a `fetch` to answer requests yourself, and a `baseUrl` to point the SDK at a local server:

```ts
const sv = new SplatterVault({
  apiKey: "sv_org_test",
  fetch: async (url, init) => new Response(JSON.stringify({ balance: 100 }), { status: 200 })
});
```

## Developing this SDK

```sh
npm install
npm run generate   # src/generated/studio-api.ts from openapi/studio-api.json (or: npm run generate -- <file or URL>)
npm run check      # typecheck, lint, tests, build, then the packed package from ESM and CJS
npm run docs       # API documentation (HTML) into docs/
```

Integration tests run against the local API mock in [`tools/sdk-mock`](tools/sdk-mock/README.md) (Node 18+, no
dependencies, fake test credentials; it never calls SplatterVault) when `SV_MOCK_URL` is set:

```sh
node tools/sdk-mock/server.mjs --port 8787 &     # or, in its own terminal: npm run mock
SV_MOCK_URL=http://127.0.0.1:8787/rest npm test   # every test, including the integration suite
npm run mock:selftest                            # the mock's own check against openapi/studio-api.json
```

## License

[MIT](LICENSE)
