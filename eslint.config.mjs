import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // tools/sdk-mock is the API mock shared, unchanged, by every SplatterVault SDK repository (it has its own self-test).
  { ignores: ["dist/**", "docs/**", "coverage/**", "node_modules/**", "src/generated/**", "tools/sdk-mock/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: {
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        Headers: "readonly",
        Response: "readonly",
        fetch: "readonly",
        globalThis: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-control-regex": "off"
    }
  },
  {
    files: ["test/**", "smoke/**", "examples/**", "scripts/**"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" }
  },
  {
    // The CommonJS consumer smoke test is CommonJS on purpose.
    files: ["smoke/*.cjs", "smoke/*.cts"],
    languageOptions: { sourceType: "commonjs", globals: { require: "readonly", module: "writable" } },
    rules: { "@typescript-eslint/no-require-imports": "off" }
  }
);
