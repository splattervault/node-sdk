import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The examples import the package by name; tests run them against the source.
    alias: { "@splattervault/server": fileURLToPath(new URL("./src/index.ts", import.meta.url)) }
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    coverage: { provider: "v8", include: ["src/**/*.ts"], exclude: ["src/generated/**"] }
  }
});
