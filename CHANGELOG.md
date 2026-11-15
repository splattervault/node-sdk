# Changelog

All notable changes to `@splattervault/server` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [semantic versioning](https://semver.org/);
while it is 0.x, a minor version may change the API.

## [0.1.0] - Unreleased (preview)

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
