#!/usr/bin/env node
// Consumer smoke test: packs the package (npm pack), checks what the tarball holds, installs it into an empty
// project in a temp folder and runs it from ESM and CJS, then type-checks both entry points as a consumer would.
// Run `npm run build` first.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });

const work = mkdtempSync(join(tmpdir(), "sv-node-sdk-smoke-"));
const [packed] = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", work], root));
const files = packed.files.map((f) => f.path).sort();
const allowed = (p) => p.startsWith("dist/") || ["package.json", "README.md", "CHANGELOG.md", "LICENSE"].includes(p);
const stray = files.filter((p) => !allowed(p));
if (stray.length) throw new Error(`the tarball holds files it should not: ${stray.join(", ")}`);
for (const need of ["dist/index.js", "dist/index.cjs", "dist/index.d.ts", "dist/index.d.cts", "README.md", "LICENSE", "CHANGELOG.md"]) {
  if (!files.includes(need)) throw new Error(`the tarball lacks ${need}`);
}
console.log(`tarball ${packed.filename}: ${files.length} files, ${packed.size} bytes packed`);

const app = join(work, "app");
mkdirSync(app, { recursive: true });
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "smoke-app", private: true, version: "0.0.0" }));
run(npm, ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--offline", join(work, packed.filename)], app);
const installed = JSON.parse(readFileSync(join(app, "node_modules/@splattervault/server/package.json"), "utf8"));
if (Object.keys(installed.dependencies ?? {}).length) throw new Error("the package has runtime dependencies");

for (const f of ["shared.cjs", "esm.mjs", "cjs.cjs", "types-esm.mts", "types-cjs.cts"]) copyFileSync(join(root, "smoke", f), join(app, f));
process.stdout.write(run(process.execPath, ["esm.mjs"], app));
process.stdout.write(run(process.execPath, ["cjs.cjs"], app));

// Types, as a consumer with moduleResolution node16 sees them (import → index.d.ts, require → index.d.cts).
writeFileSync(
  join(app, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      module: "node16",
      moduleResolution: "node16",
      target: "ES2022",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: ["node"],
      typeRoots: [join(root, "node_modules/@types")]
    },
    files: ["types-esm.mts", "types-cjs.cts"]
  })
);
run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(app, "tsconfig.json")], app);
console.log("types: ok (ESM and CJS, node16 resolution)");
console.log(`smoke test passed in ${work}`);
