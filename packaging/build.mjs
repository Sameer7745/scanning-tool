// build.mjs — bundle the bridge (server/) into one CJS file and stage the web
// UI + a pkg config into packaging/dist-bin, ready to turn into single-file
// binaries with pkg.mjs. See packaging/README.md.

import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // packaging/
const root = join(here, "..");
const out = join(here, "dist-bin");
const server = join(root, "server");
const webDist = join(root, "web", "dist");

console.log("• cleaning dist-bin/");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

if (!existsSync(join(webDist, "index.html"))) {
  console.error("! web/dist is missing — run `npm run build:web` (repo root) first.");
  process.exit(1);
}

console.log("• bundling server -> dist-bin/bridge.cjs");
await build({
  entryPoints: [join(server, "index.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: join(out, "bridge.cjs"),
  // CJS has no import.meta.url — shim it to the bundle's own file URL so our
  // fileURLToPath(import.meta.url) path logic keeps working.
  banner: {
    js:
      "/* Scan Bridge — bundled. Powered by Accucia Softwares. */\n" +
      "const __IMPORT_META_URL__ = require('url').pathToFileURL(__filename).href;",
  },
  define: { "import.meta.url": "__IMPORT_META_URL__" },
  logLevel: "warning",
});

console.log("• copying web UI -> dist-bin/web/");
// Exclude any downloadable binaries so the exe never embeds copies of itself.
cpSync(webDist, join(out, "web"), {
  recursive: true,
  filter: (src) => !/ScanBridge-[^/\\]*$/.test(src),
});

console.log("• copying tray helper binaries -> dist-bin/traybin/");
const traybinSrc = join(server, "node_modules", "systray2", "traybin");
if (existsSync(traybinSrc)) {
  cpSync(traybinSrc, join(out, "traybin"), { recursive: true });
  for (const f of readdirSync(join(out, "traybin"))) { try { chmodSync(join(out, "traybin", f), 0o755); } catch {} }
}
else console.warn("  (systray2 traybin not found — tray will be disabled)");

// The mock backend's sample page (used when no scanner driver is installed).
console.log("• copying sample scan -> dist-bin/assets/");
cpSync(join(server, "assets"), join(out, "assets"), { recursive: true });

console.log("• writing pkg config -> dist-bin/package.json");
writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: "scan-bridge",
      version: "1.0.0",
      bin: "bridge.cjs",
      pkg: {
        assets: ["web/**/*", "traybin/**/*", "assets/**/*"],
        targets: [
          "node20-win-x64",
          "node20-linux-x64",
          "node20-macos-x64",
          "node20-macos-arm64",
        ],
        outputPath: "out",
      },
    },
    null,
    2
  )
);

console.log("\n✓ Staged packaging/dist-bin/. Next: `npm run pkg` to produce the executables in binaries/.");
