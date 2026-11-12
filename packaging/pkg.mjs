// pkg.mjs — turn the staged bundle (packaging/dist-bin/) into single-file
// executables in binaries/, named to match web/public/downloads/manifest.json.
//
// Run AFTER `npm run bundle`. Requires internet the first time (pkg downloads
// prebuilt Node base binaries into ~/.pkg-cache). See packaging/README.md.
//
//   node pkg.mjs            # build all targets
//   node pkg.mjs win        # build only Windows (also: mac-arm, mac-x64, linux)

import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // packaging/
const root = join(here, "..");
const entry = join(here, "dist-bin", "bridge.cjs");
const cfg = join(here, "dist-bin", "package.json");
const ICON = join(here, "icon", "scan-bridge.ico");
const VERSION = JSON.parse(readFileSync(join(root, "server", "package.json"), "utf8")).version;
// Output to a SEPARATE folder (NOT web/) — otherwise the web build would copy
// these binaries into dist/ and each exe would embed the others.
const outDir = join(root, "binaries");

// Flip a Windows exe from the CONSOLE subsystem to GUI, so no black console
// window appears when it runs. (It auto-opens the browser to the panel instead.)
function hideWindowsConsole(file) {
  try {
    const buf = readFileSync(file);
    const peOff = buf.readUInt32LE(0x3c);
    if (buf.readUInt32LE(peOff) !== 0x00004550) return false; // "PE\0\0"
    const subsystemOff = peOff + 24 + 68; // optional header + 68
    if (buf.readUInt16LE(subsystemOff) === 3) {
      buf.writeUInt16LE(2, subsystemOff); // 3=CONSOLE -> 2=GUI
      writeFileSync(file, buf);
      return true;
    }
  } catch {}
  return false;
}

/**
 * A copy of pkg's Windows Node base binary with our icon and file details
 * (name, company, version shown in Explorer > Properties). pkg then builds the
 * exe from it via PKG_NODE_PATH. The finished exe can't be edited instead: pkg
 * records where its payload sits, and resizing the resources would move it.
 */
async function windowsBaseWithIcon(nodeRange) {
  // pkg-fetch is pkg's own downloader; resolve it from pkg so the cache matches.
  const fromPkg = createRequire(createRequire(import.meta.url).resolve("@yao-pkg/pkg/package.json"));
  const { need } = fromPkg("@yao-pkg/pkg-fetch");
  const ResEdit = createRequire(import.meta.url)("resedit");

  const base = await need({ nodeRange, platform: "win", arch: "x64" });
  const exe = ResEdit.NtExecutable.from(readFileSync(base), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  const icons = ResEdit.Data.IconFile.from(readFileSync(ICON)).icons.map((i) => i.data);
  const group = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)[0];
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group ? group.id : 1, group ? group.lang : 1033, icons);

  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (vi) {
    const [major, minor, patch] = VERSION.split(".").map(Number);
    for (const lang of vi.getAllLanguagesForStringValues()) {
      vi.setStringValues(lang, {
        ProductName: "Scan Bridge",
        FileDescription: "Scan Bridge — connects your scanner to the browser",
        CompanyName: "Accucia Softwares",
        LegalCopyright: `© ${new Date().getFullYear()} Accucia Softwares`,
        OriginalFilename: "ScanBridge-win-x64.exe",
        InternalName: "ScanBridge",
        FileVersion: VERSION,
        ProductVersion: VERSION,
      });
    }
    vi.setFileVersion(major || 0, minor || 0, patch || 0, 0, 1033);
    vi.setProductVersion(major || 0, minor || 0, patch || 0, 0, 1033);
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);

  const patched = join(here, ".cache", `${nodeRange}-win-x64-scanbridge.exe`);
  mkdirSync(dirname(patched), { recursive: true });
  writeFileSync(patched, Buffer.from(exe.generate()));
  return patched;
}

if (!existsSync(entry)) {
  console.error("! packaging/dist-bin/bridge.cjs missing — run `npm run bundle` first.");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

// target key -> [pkg target triple, output filename matching manifest.json]
// node22 is what @yao-pkg/pkg-fetch ships prebuilt (tag v3.6), so these fetch
// instead of trying to compile Node from source.
const TARGETS = {
  win: ["node22-win-x64", "ScanBridge-win-x64.exe"],
  "mac-arm": ["node22-macos-arm64", "ScanBridge-macos-arm64"],
  "mac-x64": ["node22-macos-x64", "ScanBridge-macos-x64"],
  linux: ["node22-linux-x64", "ScanBridge-linux-x64"],
};

const pick = process.argv[2];
const keys = pick ? [pick] : Object.keys(TARGETS);

for (const k of keys) {
  const t = TARGETS[k];
  if (!t) { console.error(`! unknown target "${k}" (use: ${Object.keys(TARGETS).join(", ")})`); continue; }
  const [triple, outName] = t;
  const output = join(outDir, outName);
  console.log(`\n• building ${k} -> binaries/${outName}`);
  try {
    const env = { ...process.env };
    if (k === "win") {
      try {
        env.PKG_NODE_PATH = await windowsBaseWithIcon(triple.split("-")[0]);
        console.log("  ✓ icon and file details added");
      } catch (e) {
        console.warn(`  (could not add the icon, building without it: ${e.message || e})`);
      }
    }
    execFileSync(
      "npx",
      [
        "@yao-pkg/pkg", entry, "--config", cfg,
        // Store plain JS instead of V8 bytecode, so CROSS-built binaries (e.g.
        // a Windows exe built on macOS) run on the target. Required for cross-build,
        // and for PKG_NODE_PATH (bytecode would run that Windows base on this host).
        "--public", "--public-packages", "*", "--no-bytecode",
        "--targets", triple, "--output", output,
      ],
      { stdio: "inherit", cwd: here, env }
    );
    if (k === "win" && hideWindowsConsole(output)) console.log("  ✓ console window hidden (GUI subsystem)");
    console.log(`  ✓ ${outName}`);
  } catch {
    console.error(`  ✗ failed to build ${k} (needs network for base binaries, or a matching OS to compile).`);
  }
}

console.log("\nDone. Binaries are in binaries/. To serve them from the download page, copy them into web/public/downloads/ and rebuild the web.");
