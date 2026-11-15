import * as sdk from "@splattervault/server";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const run = require("./shared.cjs");
await run(sdk, "esm");
if (typeof import.meta.resolve === "function") {
  const resolved = import.meta.resolve("@splattervault/server");
  if (!resolved.endsWith("/dist/index.js")) throw new Error(`esm resolved ${resolved}`);
}

// One copy for import and require (no dual-package hazard): the same classes, so instanceof holds both ways.
const cjs = require("@splattervault/server");
if (sdk.SplatterVault !== cjs.SplatterVault || sdk.SplatterVaultError !== cjs.SplatterVaultError) {
  throw new Error("import and require loaded two copies of the SDK");
}
const client = new cjs.SplatterVault({
  apiKey: "sv_org_smoke",
  baseUrl: "http://127.0.0.1:1/rest",
  fetch: async () => new Response(JSON.stringify({ error: "nope", message: "No." }), { status: 400 })
});
const err = await client.billing.getUsage().catch((e) => e);
if (!(err instanceof sdk.SplatterVaultError)) throw new Error("an error from the require copy is not instanceof the import copy's class");
console.log("esm+cjs: one copy (instanceof holds across import and require)");
