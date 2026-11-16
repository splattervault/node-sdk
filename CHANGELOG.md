# Changelog

All notable changes to `@splattervault/server` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [semantic versioning](https://semver.org/);
while it is 0.x, a minor version may change the API.

## [0.1.2] - 2026-11-16

Where players join a session. Types and documentation only: no code change, and nothing that worked before changes.

### Changed (types, from the API description)

- `SessionConnection` lists `ports` (`{ id, label, port, protocol? }[]`) and `instructions` (`{ summary?, steps? } | null`),
  which the API already sent, and every field has a description. `primaryPort` is the port players join on: the
  session's room port for a game launched with `{{slavePort}}` or `{{port}}` in a launch argument (null until the
  server has started the room), otherwise the game's configured "game" port (for example 25565 for Minecraft Java).
- `ServerSession.slavePort` is described as the room port the server gave the session (8100 and up), which only
  games launched with `{{slavePort}}` listen on; `ServerSession.connection` and `PoolClaimAnswer.connection` say
  when they are null. `sessions.get` (`GET /game-sessions/{id}`, also with `slim`) answers `connection`.

### Documentation

- README and `examples/match-server.ts`: a pool claim's `connection.primaryPort` is null for a game launched with the
  room port (the server starts the room after the claim), so the examples wait with `sessions.waitUntilReady` and
  read the session's `connection` unless the claim answer already has the port. Send players to `connection.host` and
  `connection.primaryPort`, not `slaveIp` and `slavePort`.
- `readSessionEnvironment()`: SplatterVault servers do not set `SLAVE_PORT` today, so `slavePort` is null there; a
  game server listens on the port its launch arguments give it (`{{slavePort}}` / `{{port}}` for the session's room
  port, `{{gamePort}}` for the game's configured port). The docs used to call it "the base game port".
- `sessions.get` and `serverPools.claim` doc comments say the same.

## [0.1.1] - 2026-11-15

Follows the corrected Studio API description (API main c002ca7f, https://splattervault.com/docs/studio/swagger.json).

### Added

- `poolClaimConflict(err)`: tells a `serverPools.claim` 409 apart by the API's message: `"no_warm_server"` (none idle:
  start a session instead) or `"busy"` (the "— retry" messages: contention; trying the claim again shortly is safe;
  nothing was claimed). The SDK still never retries a claim itself (it starts servers). The README and
  `examples/match-server.ts` show the fallback.

### Changed (types, from the API description)

- `CreditBalance`: `createdAt` and `updatedAt` are now `string | null` (an organization API key's answer has null
  dates); new fields `availableBalance`, `graceExpiresAt` (`string | null`) and `user` (an object, or null; null for
  an organization key). Code that assigned `createdAt` to a non-null `string` must now handle null. The SDK itself
  never reads these fields.
- Every GET operation's parameters now list an optional `If-None-Match` header, and its answers `ETag`, `304` and
  `x-request-id` headers (`components["headers"]["RequestId"]`); `serverPools.claim` lists its `409` answer. Request
  and answer bodies are unchanged apart from `CreditBalance`.

### Documentation

- The game-server session and billing routes never answer 429 (the API sets no rate limit on them): said so in the
  README and on `Sessions` / `Billing`; only the studio routes answer `429 rate_limited`.
- Conditional requests: every GET documents ETags, but the SDK never sends `If-None-Match` itself, so it never meets
  a 304; if you send one in `headers`, it adds `Cache-Control: max-age=0` and a 304 rejects with status 304 (as in
  0.1.0). The contract test now checks exactly that instead of "no operation documents ETags".

## [0.1.0] - 2026-11-15 (preview)

The first release: the Studio API's server operations (organization API key) for Node.js 18 and later.

### Added

- `SplatterVault` client with the API key from `apiKey` or `SV_API_KEY`; refuses to start in a browser, a web
  worker or React Native unless `dangerouslyAllowBrowser`; never shows the key in logs, `util.inspect`, JSON or errors.
- Game-server sessions: `sessions.create/list/get/listMine/stop/rename/reschedule/cancelSchedule`, the same for
  subscription-billed sessions under `sessions.subscription`, `serverPools.claim`, `games.getConfigurableArgs`, and
  `sessions.waitUntilReady` (polls until the game is ready; `SessionWaitError` with `session_ended` / `wait_timeout`).
- Billing: `billing.getCredits/getCreditStats/getOrgCredits/getOrgSubscriptions/getOrgCreditsById/getOrgSubscriptionById/getSubscriptions/getUsage`.
- Player sign-in from your backend: `players.signIn/import/erase`.
- Player data: `playerData.resolve/get/update/clear/getMany/writeMany/getGameData/updateGameData/import/listErasedPlayers`
  and the `playerData.erasedPlayerPages` page iterator.
- Store: `store.getCatalog/getPlayer/getHistory/grant/consume/purchase/updateItem/reverse/syncMetaPurchases/importCatalog/importHoldings`
  and the `store.historyPages` page iterator. Store changes send an `Idempotency-Key` (made per call, reused on
  retries, or yours with `{ idempotencyKey }`; `null` makes one, so `err.idempotencyKey` can be passed straight back).
- Offline player-token verification: `verifyPlayerToken`, `createPlayerTokenVerifier`, `sv.verifyPlayerToken`
  (Ed25519 with `node:crypto`; the JWKS from `GET /player-auth/keys` cached per its Cache-Control, at least 60 s and
  at most an hour, fetched again on an unknown key id, stale keys usable 300 s while the API is unreachable; the API's
  own checks plus your game id; sign-in methods added later are accepted).
- `readSessionEnvironment()` for game processes started by SplatterVault.
- `SplatterVaultError` with `status`, `code`, `message`, `details`, `retryAfter`, `requestId` (both API error shapes),
  `outcomeUnknown` (a write that may or may not have been applied) and `idempotencyKey` (the key a store change was
  sent with, to resend it exactly once).
- Retries for safe calls only, on network errors, timeouts, 408, 429, 500, 502, 503 and 504, honouring `Retry-After`,
  with jittered exponential backoff: reads, lookups, imports and `clear`; store changes with the same Idempotency-Key
  and body (also after a resend meets its own in-progress `idempotency_conflict`); player-data writes whose every op
  has `ifVersion` only after 408, 429 or 503 (never after an unknown outcome; a resend that meets `version_conflict` is
  `outcome_unknown`). Per-attempt timeouts; `AbortSignal` support.
- Safety: redirects are never followed (`redirect_not_followed`), so the API key never goes to another address; plain
  http only for loopback hosts (or `dangerouslyAllowInsecureHttp`), for the API and the player-token keys alike;
  numeric options validated (NaN, Infinity and out-of-range values throw); `.` and `..` path parameters and empty
  `stores` / `keys` lists refused; the SDK refuses to start in Electron and NW.js as in browsers.
- One copy for `import` and `require` (the ES module entry re-exports the CommonJS build): `instanceof` holds across
  both, and the key cache is shared.
- Request and answer types generated from the Studio API's OpenAPI description (`npm run generate`).
- ESM and CommonJS builds with type declarations; no runtime dependencies.

### API description

- `openapi/studio-api.json` is the corrected Studio API description: `StoreHoldingsImportRequest.rows[].balances` is
  `{ [currency code]: amount }` (an integer of at least 0 per code), not a list of `{ currency, amount }`. The
  generated type changed accordingly (`balances?: { [key: string]: number }`).
- `ServerSession` now lists `ready`, `readyAt` and `readyDeadlineAt` (optional; the times nullable), so `ReadySession`
  is an alias of `ServerSession`.
- Its code samples now name the key variable `SV_API_KEY`.
