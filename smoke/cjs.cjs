"use strict";
const sdk = require("@splattervault/server");
const run = require("./shared.cjs");

const resolved = require.resolve("@splattervault/server");
if (!resolved.endsWith("/dist/index.cjs")) throw new Error(`cjs resolved ${resolved}`);
run(sdk, "cjs").catch((err) => {
  console.error(err);
  process.exit(1);
});
