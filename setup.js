// setup.js — detect the scanner backend (NAPS2/SANE) and, if missing, install it
// automatically where possible (winget on Windows, Homebrew on macOS). Linux is
// left manual (needs sudo).

import { spawn, spawnSync } from "node:child_process";
import { detectBackend } from "./scanner.js";

function hasCmd(cmd) {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    return spawnSync(probe, [cmd], { timeout: 6000 }).status === 0;
  } catch {
    return false;
  }
}

/** What's installed and whether we can auto-install the backend here. */
export function setupInfo() {
  const platform = process.platform;
  const backend = detectBackend().backend;
  const installed = backend !== "mock";

  let method = null;
  let pkg = "NAPS2";
  let manualUrl = "https://www.naps2.com/download";

  if (platform === "win32") method = hasCmd("winget") ? "winget" : null;
  else if (platform === "darwin") method = hasCmd("brew") ? "brew" : null;
  else {
    pkg = "SANE (sane-utils)";
    manualUrl = "";
    method = null; // apt needs sudo — don't auto-run
  }

  return {
    platform,
    backend,
    installed,
    pkg,
    method,
    manualUrl,
    canAutoInstall: !installed && !!method,
  };
}

/** The install command for this platform, or null if none. */
export function installCommand() {
  if (process.platform === "win32")
    return [
      "winget",
      ["install", "--id", "Cyanfish.NAPS2", "-e", "--silent",
       "--accept-package-agreements", "--accept-source-agreements"],
    ];
  if (process.platform === "darwin")
    return ["brew", ["install", "--cask", "naps2"]];
  return null;
}

/** Run the install, collecting output. Calls back (err, { code, output }). */
export function runInstall(onDone) {
  const cmd = installCommand();
  if (!cmd) return onDone(new Error("No automatic installer on this platform."));
  const child = spawn(cmd[0], cmd[1], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const grab = (d) => (out += d.toString());
  child.stdout.on("data", grab);
  child.stderr.on("data", grab);
  const timer = setTimeout(() => child.kill(), 300000); // 5 min cap
  child.on("error", (e) => {
    clearTimeout(timer);
    onDone(e);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    onDone(null, { code, output: out.slice(-4000) });
  });
}
