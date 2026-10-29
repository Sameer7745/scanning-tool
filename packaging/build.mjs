// build.mjs — bundle the bridge (the parent server/ folder) into one CJS file
// plus the web UI, staged in ./dist-bin, ready to turn into single-file binaries.
//
// Paths are configurable for your server layout:
//   WEB_DIST=/path/to/web/dist   (the built web UI; defaults to ../../web/dist)
//
// Usage:
//   npm install          # once (installs esbuild + pkg)
//   WEB_DIST=/var/www/.../web/dist npm run bundle

import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // server/packaging
const serverDir = resolve(here, "..");                // server/
const out = join(here, "dist-bin");
const webDist = process.env.WEB_DIST
  ? resolve(process.env.WEB_DIST)
  : resolve(serverDir, "..", "web", "dist");           // default monorepo layout

console.log(`• server source: ${serverDir}`);
console.log(`• web UI:        ${webDist}`);

if (!existsSync(join(serverDir, "index.js"))) {
  console.error("! server/index.js not found next to packaging/. Run from server/packaging.");
  process.exit(1);
}
if (!existsSync(join(webDist, "index.html"))) {
  console.error(`! web UI not found at ${webDist}. Build it (web: npm run build) or set WEB_DIST.`);
  process.exit(1);
}

console.log("• cleaning dist-bin/");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

console.log("• bundling server -> dist-bin/bridge.cjs");
await build({
  entryPoints: [join(serverDir, "index.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: join(out, "bridge.cjs"),
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

console.log("• writing pkg config -> dist-bin/package.json");
writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    { name: "scan-bridge", version: "1.0.0", bin: "bridge.cjs", pkg: { assets: ["web/**/*"] } },
    null,
    2
  )
);

console.log("\n✓ Staged dist-bin/. Next: `npm run pkg` to produce the executables.");
