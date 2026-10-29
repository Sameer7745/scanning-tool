// scanner.js
// OS-agnostic scanner driver. Auto-detects whichever free scanning CLI is
// installed on THIS machine (the one the scanner is plugged into):
//
//   1. NAPS2  (cross-platform: Windows / macOS / Linux) -> TWAIN / WIA / SANE / Apple / ESCL
//   2. SANE   `scanimage` (macOS / Linux)               -> SANE backends
//
// It exposes two things the HTTP layer needs:
//   - detectBackend()      -> which CLI we will use (or 'mock')
//   - startScan(opts)      -> spawns the scan process into a temp folder and
//                             returns { dir, child, backend }. The caller watches
//                             `dir` for new page files and streams them out.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { esclBase, startEsclScan } from "./escl.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Candidate executable names/paths for NAPS2, in priority order. Includes the
// macOS and Windows app-bundle locations where the console binary lives when
// NAPS2 is installed as an app (not on PATH).
const NAPS2_CANDIDATES = [
  "naps2",
  "NAPS2.Console",
  "NAPS2.Console.exe",
  // macOS app bundle:
  "/Applications/NAPS2.app/Contents/MacOS/NAPS2.Console",
  "/Applications/NAPS2.app/Contents/MacOS/NAPS2",
  // Windows default install:
  "C:/Program Files/NAPS2/NAPS2.Console.exe",
  "C:/Program Files (x86)/NAPS2/NAPS2.Console.exe",
];
const SCANIMAGE = "scanimage";

// Default NAPS2 driver per platform (what actually talks to the hardware).
// macOS "apple" = ImageCaptureCore, the same subsystem Image Capture.app uses,
// which supports AirScan/eSCL scanners like the HP Smart Tank out of the box.
const NAPS2_DEFAULT_DRIVER =
  process.platform === "win32" ? "wia"
  : process.platform === "darwin" ? "apple"
  : "sane";

function canRun(cmd, args) {
  try {
    // windowsHide stops a console window from flashing when we probe NAPS2.
    const r = spawnSync(cmd, args, { timeout: 8000, windowsHide: true });
    return r.status === 0 || r.status === null ? r.error == null : false;
  } catch {
    return false;
  }
}

// Cache the detected backend briefly so we don't spawn NAPS2 on every request
// (which, on Windows, is what caused repeated console pop-ups).
let _backendCache = { value: null, at: 0 };
const BACKEND_TTL = 15000;
/** Clear the cached backend (e.g. right after installing a driver). */
export function resetBackendCache() {
  _backendCache = { value: null, at: 0 };
}

/** Returns { backend: 'escl'|'naps2'|'scanimage'|'mock', command: string|null }. */
export function detectBackend() {
  if (_backendCache.value && Date.now() - _backendCache.at < BACKEND_TTL) {
    return _backendCache.value;
  }
  const result = detectBackendUncached();
  _backendCache = { value: result, at: Date.now() };
  return result;
}

function detectBackendUncached() {
  if (process.env.MOCK === "1") return { backend: "mock", command: null };

  // SCAN_MODE flag (from .env): usb | wireless | auto (default).
  //   usb      -> always use the local USB scanner (NAPS2 / SANE); ignore network.
  //   wireless -> always use the network scanner (eSCL discovery).
  //   auto     -> wireless if SCANNER_URL/SCANNER_NAME is set, else USB.
  const mode = (process.env.SCAN_MODE || "auto").toLowerCase();

  const wantWireless =
    mode === "wireless" ||
    (mode === "auto" && (process.env.SCANNER_URL || process.env.SCANNER_NAME));

  // Wireless (eSCL) — no drivers. Finds the scanner by URL/name/discovery.
  //   SCANNER_URL=http://192.168.1.36/eSCL   fixed IP (auto-rediscovers if it moves)
  //   SCANNER_NAME="HP Smart Tank"            discover by name (survives IP changes)
  if (mode !== "usb" && wantWireless) {
    const url = process.env.SCANNER_URL;
    const command =
      url && url.toLowerCase() !== "auto" ? esclBase(url) : "auto (network discovery)";
    return { backend: "escl", command };
  }

  // --- USB / local path (SCAN_MODE=usb, or auto with no network config) ---
  // Explicit overrides win: SCAN_BACKEND=naps2|scanimage, SCAN_CMD=<path>.
  if (process.env.SCAN_CMD) {
    const backend = process.env.SCAN_BACKEND || "naps2";
    return { backend, command: process.env.SCAN_CMD };
  }

  for (const c of NAPS2_CANDIDATES) {
    // App-bundle paths must exist; bare names are resolved via PATH by canRun.
    const isPath = c.includes("/") || c.includes("\\");
    if (isPath && !existsSync(c)) continue;
    // The standalone "NAPS2" binary (macOS/Linux) is invoked as `NAPS2 console`;
    // the "NAPS2.Console[.exe]" binary (Windows) takes flags directly.
    const base = c.replace(/\\/g, "/").split("/").pop().toLowerCase();
    const probe = base.includes("console") ? ["--help"] : ["console", "--help"];
    if (canRun(c, probe)) return { backend: "naps2", command: c };
  }
  if (canRun(SCANIMAGE, ["--version"])) {
    return { backend: "scanimage", command: SCANIMAGE };
  }
  return { backend: "mock", command: null };
}

/** List available scanner devices (best-effort; UI treats this as optional). */
export function listDevices() {
  const { backend, command } = detectBackend();

  if (backend === "escl") {
    // Configured network scanner — report it without a (blocking) live fetch.
    return { backend, devices: [{ id: command, name: `Network scanner (${command})` }] };
  }

  if (backend === "scanimage") {
    const r = spawnSync(command, ["-L"], { encoding: "utf8", timeout: 15000, windowsHide: true });
    const out = (r.stdout || "") + (r.stderr || "");
    // Lines look like: device `epson2:net:...' is a Epson ...
    const devices = [];
    for (const line of out.split("\n")) {
      const m = line.match(/device `([^']+)'\s+is a\s+(.*)/i);
      if (m) devices.push({ id: m[1], name: m[2].trim() });
    }
    return { backend, devices };
  }

  if (backend === "naps2") {
    // NAPS2 needs a driver to enumerate; try the platform defaults.
    // Only the LOCAL/USB drivers here — network scanning is handled by our own
    // eSCL backend (SCAN_MODE=wireless), and enumerating NAPS2's network driver
    // is slow/can hang, which we avoid.
    const drivers =
      process.platform === "win32"
        ? ["wia", "twain"]
        : process.platform === "darwin"
        ? ["apple"]
        : ["sane"];
    const devices = [];
    const prefix = naps2Prefix(command);
    for (const d of drivers) {
      const r = spawnSync(command, [...prefix, "--listdevices", "--driver", d], {
        encoding: "utf8",
        timeout: 20000,
        windowsHide: true,
      });
      const out = (r.stdout || "").trim();
      if (out) {
        for (const name of out.split("\n").map((s) => s.trim()).filter(Boolean)) {
          devices.push({ id: `${d}:${name}`, name: `${name} (${d})` });
        }
      }
    }
    return { backend, devices };
  }

  return { backend, devices: [{ id: "mock", name: "Mock scanner (sample image)" }] };
}

// The standalone "NAPS2" binary (macOS/Linux) needs the `console` subcommand;
// the Windows "NAPS2.Console.exe" takes flags directly. Returns the argv prefix.
function naps2Prefix(command) {
  const base = String(command).replace(/\\/g, "/").split("/").pop().toLowerCase();
  return base.includes("console") ? [] : ["console"];
}

/**
 * Start a scan. Writes one JPEG per page into a fresh temp dir.
 *
 * opts = {
 *   mode: 'single' | 'continuous',  // continuous = pull every page from the ADF
 *   dpi:  number,                    // resolution
 *   source: 'glass'|'feeder'|'duplex'|string|undefined,
 *   device: string|undefined
 * }
 *
 * Returns { dir, backend, child }  (child is null for the mock backend).
 */
export function startScan(opts = {}) {
  const { backend, command } = detectBackend();
  const mode = opts.mode === "continuous" ? "continuous" : "single";
  const dpi = Number(opts.dpi) > 0 ? Number(opts.dpi) : 200;
  const dir = mkdtempSync(join(tmpdir(), "scan-"));

  if (backend === "mock") {
    return { dir, backend, child: null, mock: runMock(dir, mode) };
  }

  if (backend === "escl") {
    // Direct network scan by URL/IP — pure HTTP, no child process.
    const escl = startEsclScan(dir, {
      url: command,
      mode,
      dpi,
      source: opts.source,
    });
    return { dir, backend, child: null, escl, command, args: [`mode=${mode}`, `dpi=${dpi}`] };
  }

  let args;
  if (backend === "scanimage") {
    args = buildScanimageArgs({ dir, mode, dpi, opts });
  } else {
    // NAPS2 requires an explicit device. If the UI didn't pick one, grab the
    // first detected scanner for the default driver.
    const resolved = { ...opts };
    if (!resolved.device) {
      try {
        const { devices } = listDevices();
        if (devices && devices.length) resolved.device = devices[0].id;
      } catch {}
    }
    args = [...naps2Prefix(command), ...buildNaps2Args({ dir, mode, dpi, opts: resolved })];
  }

  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  // Return command+args so the caller can log exactly what ran (debugging).
  return { dir, backend, child, command, args };
}

/** Full diagnostics snapshot for the /api/diagnostics endpoint. */
export function diagnostics() {
  const info = { platform: process.platform, node: process.version };
  try {
    const { backend, command } = detectBackend();
    info.backend = backend;
    info.command = command;
    // Backend version string, best-effort.
    if (backend === "scanimage") {
      const r = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 8000, windowsHide: true });
      info.backendVersion = (r.stdout || r.stderr || "").split("\n")[0]?.trim();
    } else if (backend === "naps2") {
      const r = spawnSync(command, [...naps2Prefix(command), "--help"], {
        encoding: "utf8",
        timeout: 8000,
        windowsHide: true,
      });
      info.backendVersion = (r.stdout || "").split("\n")[0]?.trim();
    }
    const { devices } = listDevices();
    info.devices = devices;
    info.deviceCount = devices.length;
  } catch (e) {
    info.error = String(e && e.message ? e.message : e);
  }
  return info;
}

// The UI sends NAPS2-style source names (glass/feeder/duplex); SANE/scanimage
// (and sane-airscan) expect Flatbed/ADF/"ADF Duplex". Translate.
function saneSource(source) {
  switch (String(source || "").toLowerCase()) {
    case "glass":
      return "Flatbed";
    case "feeder":
      return "ADF";
    case "duplex":
      return "ADF Duplex";
    default:
      return source; // pass through anything explicit
  }
}

function buildScanimageArgs({ dir, mode, dpi, opts }) {
  const args = ["--format=jpeg", `--resolution=${dpi}`];
  if (opts.device) args.push("-d", opts.device);
  const src = saneSource(opts.source);

  if (mode === "continuous") {
    // ADF batch: scanimage writes page-001.jpg, page-002.jpg ... until the
    // feeder is empty, then exits with "Document feeder out of documents".
    args.push("--source", src || "ADF");
    args.push(`--batch=${join(dir, "page-%03d.jpg")}`);
  } else {
    if (src) args.push("--source", src);
    args.push("-o", join(dir, "page-001.jpg"));
  }
  return args;
}

function buildNaps2Args({ dir, mode, dpi, opts }) {
  // NAPS2 uses the $(n) placeholder to number multi-page output.
  const output = join(dir, "page-$(n).jpg");

  // Device id from listDevices() looks like "driver:name" (e.g.
  // "apple:HP Smart Tank 580-590 series [302700]"). Split off the driver so we
  // set --driver and --device consistently (and never duplicate --driver).
  let driver = process.env.NAPS2_DRIVER || NAPS2_DEFAULT_DRIVER;
  let device = opts.device ? String(opts.device) : "";
  const KNOWN = ["twain", "wia", "sane", "apple", "escl"];
  const sep = device.indexOf(":");
  if (sep > 0 && KNOWN.includes(device.slice(0, sep).toLowerCase())) {
    driver = device.slice(0, sep);
    device = device.slice(sep + 1);
  }

  // NOTE: the `console` subcommand (for the standalone binary) is prepended by
  // the caller via naps2Prefix(); these are the flags only.
  const args = ["-o", output, "--dpi", String(dpi), "--driver", driver];

  // Map our source names to NAPS2's (glass | feeder | duplex).
  const source = opts.source || (mode === "continuous" ? "feeder" : "glass");
  args.push("--source", source);

  if (device) args.push("--device", device);
  return args;
}

/**
 * Mock backend: copies the bundled WhatsApp sample image as 1 page (single)
 * or 3 pages (continuous) with a small delay, so the full UI works with no
 * hardware. Enable with MOCK=1.
 */
function runMock(dir, mode) {
  const sample = join(__dirname, "..", "WhatsApp Image 2026-10-07 at 2.18.16 PM.jpeg");
  const count = mode === "continuous" ? 3 : 1;
  let i = 0;
  const timers = [];
  const emit = () => {
    i += 1;
    const target = join(dir, `page-${String(i).padStart(3, "0")}.jpg`);
    if (existsSync(sample)) copyFileSync(sample, target);
    if (i < count) timers.push(setTimeout(emit, 1200));
  };
  timers.push(setTimeout(emit, 600));
  return {
    cancel: () => timers.forEach(clearTimeout),
    totalApprox: count,
  };
}
