// pkg.mjs — turn the staged bundle (dist-bin/) into single-file executables.
// Run AFTER `npm run bundle`. Needs internet the first time (downloads prebuilt
// Node base binaries from @yao-pkg/pkg-fetch).
//
// Output folder is configurable (defaults to ./out). Copy the binaries into your
// server's web downloads folder yourself.
//   OUT_DIR=/var/www/.../web/dist/downloads node pkg.mjs        # optional
//
//   node pkg.mjs            # all platforms
//   node pkg.mjs win        # one: win | mac-arm | mac-x64 | linux

import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "dist-bin", "bridge.cjs");
const cfg = join(here, "dist-bin", "package.json");
const outDir = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : join(here, "out");

if (!existsSync(entry)) {
  console.error("! dist-bin/bridge.cjs missing — run `npm run bundle` first.");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

// node22 is what @yao-pkg/pkg-fetch ships prebuilt (so it fetches, not compiles).
// key -> [pkg target, output filename]
const TARGETS = {
  win: ["node22-win-x64", "ScanBridge-win-x64.exe"],
  "mac-arm": ["node22-macos-arm64", "ScanBridge-macos-arm64"],
  "mac-x64": ["node22-macos-x64", "ScanBridge-macos-x64"],
  linux: ["node22-linux-x64", "ScanBridge-linux-x64"],
};

const pick = process.argv[2];
const keys = pick ? [pick] : Object.keys(TARGETS);
console.log(`• output folder: ${outDir}`);

for (const k of keys) {
  const t = TARGETS[k];
  if (!t) { console.error(`! unknown target "${k}" (use: ${Object.keys(TARGETS).join(", ")})`); continue; }
  const [triple, outName] = t;
  const output = join(outDir, outName);
  console.log(`\n• building ${k} -> ${outName}`);
  try {
    execFileSync(
      "npx",
      [
        "@yao-pkg/pkg", entry, "--config", cfg,
        // Store plain JS instead of V8 bytecode, so CROSS-built binaries (e.g.
        // a Windows exe built on Linux/macOS) run on the target OS.
        "--public", "--public-packages", "*",
        "--targets", triple, "--output", output,
      ],
      { stdio: "inherit", cwd: here }
    );
    console.log(`  ✓ ${outName}`);
  } catch {
    console.error(`  ✗ failed to build ${k} (needs internet for base binaries).`);
  }
}

console.log(`\nDone. Binaries are in: ${outDir}`);
console.log("Copy them into your server's web downloads folder.");
