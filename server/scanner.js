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
import { mkdtempSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { esclBase, startEsclScan } from "./escl.js";
import { log } from "./logger.js";

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

/** The command's help output, or null if it can't be run. */
function helpText(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000, windowsHide: true });
    if (r.error != null || (r.status !== 0 && r.status !== null)) return null;
    return (r.stdout || "") + (r.stderr || "");
  } catch {
    return null;
  }
}

// Cache the detected backend so we don't spawn NAPS2 on every request (which,
// on Windows, is what caused repeated console pop-ups, and each probe blocks the
// bridge). A found backend doesn't go away, so it is kept until the scan mode
// changes; only "mock" is re-checked, so a freshly installed NAPS2 is picked up.
let _backendCache = { value: null, at: 0, key: "" };
const MOCK_TTL = 15000;
/** Clear the cached backend and devices (e.g. right after installing a driver). */
export function resetBackendCache() {
  _backendCache = { value: null, at: 0, key: "" };
  resetDeviceCache();
}

/** Returns { backend: 'escl'|'naps2'|'scanimage'|'mock', command: string|null }. */
export function detectBackend() {
  // Settings that change which backend is picked (editable from the panel).
  const key = [process.env.MOCK, process.env.SCAN_MODE, process.env.SCANNER_URL, process.env.SCANNER_NAME, process.env.SCAN_CMD].join("|");
  const cached = _backendCache.value;
  if (cached && _backendCache.key === key && (cached.backend !== "mock" || Date.now() - _backendCache.at < MOCK_TTL)) {
    return cached;
  }
  const result = detectBackendUncached();
  if (cached && cached.backend !== result.backend) resetDeviceCache();
  _backendCache = { value: result, at: Date.now(), key };
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
    const help = helpText(c, probe);
    // Older NAPS2 versions reject --noprofile, so only pass it where it exists.
    if (help !== null) return { backend: "naps2", command: c, noProfile: help.includes("--noprofile") };
  }
  if (canRun(SCANIMAGE, ["--version"])) {
    return { backend: "scanimage", command: SCANIMAGE };
  }
  return { backend: "mock", command: null };
}

// --- Device list ---------------------------------------------------------
// Listing USB scanners through NAPS2 is slow (TWAIN on Windows can take 5-15 s
// per driver), so it runs as a background process (never blocking the bridge),
// one listing at a time, and the result is cached. /api/status answers from the
// cache, so the panel's status check can't time out and flip to "Offline".
const DEVICE_TTL = 10000;
const LIST_TIMEOUT = 30000; // per driver
let _devices = null; // { backend, devices, at, timedOut }
let _listing = null; // the listing in progress, shared by every caller
let _lastDevice = null; // the last scanner seen, so a scan never runs without --device
let _naps2Driver = null; // the driver that found the scanner, asked first next time
let _scansRunning = 0;

export function resetDeviceCache() {
  _devices = null;
}

/** The last device list, or null if none has finished yet. Never starts a listing. */
export function cachedDevices() {
  return _devices;
}

/** A scan is running: don't list devices meanwhile (a busy scanner lists as absent). */
export function scanStarted() {
  _scansRunning += 1;
}
export function scanEnded() {
  _scansRunning = Math.max(0, _scansRunning - 1);
}

/** Runs a command without blocking the bridge. Resolves to { code, out, err, timedOut }. */
function runAsync(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let timedOut = false;
    let settled = false;
    const end = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    };
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      err = String(e.message || e);
      return resolve({ code: null, out, err, timedOut });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {}
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      err += String(e.message || e);
      end(null);
    });
    child.on("close", (code) => end(code));
  });
}

async function enumerateDevices(backend, command) {
  if (backend === "escl") {
    // Configured network scanner — report it without a live fetch.
    return { devices: [{ id: command, name: `Network scanner (${command})` }] };
  }

  if (backend === "scanimage") {
    const r = await runAsync(command, ["-L"], LIST_TIMEOUT);
    // Lines look like: device `epson2:net:...' is a Epson ...
    const devices = [];
    for (const line of (r.out + r.err).split("\n")) {
      const m = line.match(/device `([^']+)'\s+is a\s+(.*)/i);
      if (m) devices.push({ id: m[1], name: m[2].trim() });
    }
    return { devices, timedOut: r.timedOut };
  }

  if (backend === "naps2") {
    // NAPS2 needs a driver to enumerate; try the platform defaults, the one that
    // found the scanner last time first, and stop at the first that finds one.
    // Only the LOCAL/USB drivers here — network scanning is handled by our own
    // eSCL backend (SCAN_MODE=wireless), and enumerating NAPS2's network driver
    // is slow/can hang, which we avoid.
    let drivers =
      process.platform === "win32"
        ? ["wia", "twain"]
        : process.platform === "darwin"
        ? ["apple"]
        : ["sane"];
    // NAPS2_DRIVER=twain|wia: list (and scan) through that driver only.
    const forced = String(process.env.NAPS2_DRIVER || "").toLowerCase();
    if (drivers.includes(forced)) drivers = [forced];
    else if (_naps2Driver && drivers.includes(_naps2Driver)) {
      drivers = [_naps2Driver, ...drivers.filter((d) => d !== _naps2Driver)];
    }
    const prefix = naps2Prefix(command);
    let timedOut = false;
    for (const d of drivers) {
      const r = await runAsync(command, [...prefix, "--listdevices", "--driver", d], LIST_TIMEOUT);
      if (r.timedOut) {
        timedOut = true;
        log.warn("devices", `NAPS2 --listdevices --driver ${d} timed out`);
      }
      const names = pickNames(r.out);
      if (names.length) {
        _naps2Driver = d;
        return { devices: names.map((name) => ({ id: `${d}:${name}`, name: `${name} (${d})` })) };
      }
    }
    return { devices: [], timedOut };
  }

  return { devices: [{ id: "mock", name: "Mock scanner (sample image)" }] };
}

/**
 * List available scanner devices. Resolves to { backend, devices, at, timedOut }.
 * Answers from the cache when it is younger than `maxAgeMs` (or a scan is
 * running); otherwise lists again, sharing a listing already in progress.
 */
export function listDevices({ maxAgeMs = DEVICE_TTL } = {}) {
  const { backend, command } = detectBackend();
  const cached = _devices && _devices.backend === backend ? _devices : null;
  if (cached && (_scansRunning > 0 || Date.now() - cached.at < maxAgeMs)) return Promise.resolve(cached);
  if (_scansRunning > 0) return Promise.resolve({ backend, devices: [], at: Date.now(), busy: true });
  if (!_listing) {
    _listing = enumerateDevices(backend, command)
      .then((r) => {
        // A listing that timed out says nothing about the scanner: keep what was seen before.
        if (r.timedOut && !r.devices.length && cached && cached.devices.length) {
          _devices = { ...cached, at: Date.now() };
        } else {
          _devices = { backend, devices: r.devices, at: Date.now(), timedOut: Boolean(r.timedOut) };
        }
        if (_devices.devices.length && backend !== "mock") _lastDevice = _devices.devices[0].id;
        return _devices;
      })
      .catch((e) => {
        log.error("devices", "listing failed", String(e.message || e));
        return cached || { backend, devices: [], at: Date.now() };
      })
      .finally(() => {
        _listing = null;
      });
  }
  return _listing;
}

/**
 * The device names in a NAPS2 --listdevices output. With NAPS2_DEVICE set (part
 * of a name, e.g. "M329"), only the scanners whose name contains it: a PC with
 * two scanners then always uses the right one, and shows offline without it.
 */
function pickNames(out) {
  const names = String(out).split("\n").map((s) => s.trim()).filter(Boolean);
  const want = String(process.env.NAPS2_DEVICE || "").trim().toLowerCase();
  return want ? names.filter((n) => n.toLowerCase().includes(want)) : names;
}

// Model numbers in a scanner name ("HP LJ Pro M329 TWAIN" -> ["m329"]), to match
// the same scanner across drivers, whose names differ.
const modelWords = (name) => String(name).toLowerCase().match(/[a-z]*\d[a-z\d]*/g) || [];

/**
 * On Windows, the same scanner through the other NAPS2 driver (WIA <-> TWAIN),
 * as a device id, or null. Some drivers list a scanner but can't scan with it
 * (e.g. HP's TWAIN driver answering "TWAIN error: Success" with no pages).
 */
export async function otherDriverDevice(deviceId) {
  if (process.platform !== "win32") return null;
  const { backend, command } = detectBackend();
  if (backend !== "naps2") return null;
  const used = String(deviceId || "").split(":")[0].toLowerCase();
  const other = used === "twain" ? "wia" : used === "wia" ? "twain" : null;
  if (!other) return null;
  const r = await runAsync(command, [...naps2Prefix(command), "--listdevices", "--driver", other], LIST_TIMEOUT);
  // Only the same scanner: never fall over to another one on this PC.
  const models = modelWords(String(deviceId).slice(used.length + 1));
  const name = pickNames(r.out).find((n) => models.length && modelWords(n).some((w) => models.includes(w)));
  return name ? `${other}:${name}` : null;
}

/** A device that scanned: list and use it first from now on. */
export function preferDevice(id) {
  const sep = String(id).indexOf(":");
  if (sep <= 0) return;
  _naps2Driver = id.slice(0, sep);
  _lastDevice = id;
  if (_devices) {
    const name = `${id.slice(sep + 1)} (${_naps2Driver})`;
    _devices = { ..._devices, devices: [{ id, name }, ..._devices.devices.filter((d) => d.id !== id)] };
  }
}

// The standalone "NAPS2" binary (macOS/Linux) needs the `console` subcommand;
// the Windows "NAPS2.Console.exe" takes flags directly. Returns the argv prefix.
function naps2Prefix(command) {
  const base = String(command).replace(/\\/g, "/").split("/").pop().toLowerCase();
  return base.includes("console") ? [] : ["console"];
}

// Source "auto" (no source sent): which source each scanner last scanned from.
// A scanner that has only a feeder (e.g. HP ScanJet Enterprise Flow 9000 s1)
// fails on the glass the first time; the scan is retried from the feeder (see
// /api/scan) and from then on goes straight to the feeder. Kept in memory only.
const autoSources = new Map();

export function rememberAutoSource(key, source) {
  if (key) autoSources.set(key, source);
}

/** The source to retry with when an "auto" scan returned no pages. */
export function fallbackSource(source) {
  return source === "glass" ? "feeder" : "glass";
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
 * Resolves to { dir, backend, child }  (child is null for the mock backend). When no
 * source was given (auto), also { autoSource, deviceKey }: the source picked, and
 * the key to remember it under if it works.
 */
export async function startScan(opts = {}) {
  const { backend, command, noProfile } = detectBackend();
  const mode = opts.mode === "continuous" ? "continuous" : "single";
  const dpi = Number(opts.dpi) > 0 ? Number(opts.dpi) : 200;
  const dir = mkdtempSync(join(tmpdir(), "scan-"));

  if (backend === "mock") {
    return { dir, backend, child: null, mock: runMock(dir, mode) };
  }

  const autoDefault = mode === "continuous" ? "feeder" : "glass";

  if (backend === "escl") {
    // Direct network scan by URL/IP — pure HTTP, no child process.
    const deviceKey = opts.source ? undefined : `escl:${command}`;
    const autoSource = deviceKey ? autoSources.get(deviceKey) || autoDefault : undefined;
    const source = opts.source || autoSource;
    const escl = startEsclScan(dir, {
      url: command,
      mode,
      dpi,
      source,
    });
    return { dir, backend, child: null, escl, command, args: [`mode=${mode}`, `dpi=${dpi}`, `source=${source}`], autoSource, deviceKey };
  }

  let args;
  let autoSource;
  let deviceKey;
  let resolvedDevice;
  if (backend === "scanimage") {
    // scanimage without --source uses the scanner's own default source, which
    // already suits feeder-only scanners: no auto fallback needed.
    args = buildScanimageArgs({ dir, mode, dpi, opts });
  } else {
    // NAPS2 requires an explicit device. If the UI didn't pick one, use the
    // scanner already found (no fresh listing before every scan), else list now.
    const resolved = { ...opts };
    if (!resolved.device) {
      const { devices } = await listDevices({ maxAgeMs: Infinity });
      resolved.device = (devices && devices[0] && devices[0].id) || _lastDevice || "";
    }
    if (!resolved.device) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(
        "No scanner found. Check the scanner is switched on and its USB cable is connected to this computer, then try again."
      );
    }
    if (!resolved.source) {
      deviceKey = `naps2:${resolved.device || "default"}`;
      autoSource = autoSources.get(deviceKey) || autoDefault;
      resolved.source = autoSource;
    }
    resolvedDevice = resolved.device;
    args = [...naps2Prefix(command), ...buildNaps2Args({ dir, mode, dpi, opts: resolved, noProfile })];
  }

  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  // Return command+args so the caller can log exactly what ran (debugging).
  return { dir, backend, child, command, args, autoSource, deviceKey, device: backend === "naps2" ? resolvedDevice : undefined };
}

/** Full diagnostics snapshot for the /api/diagnostics endpoint (lists devices afresh). */
export async function diagnostics() {
  const info = { platform: process.platform, node: process.version };
  try {
    const { backend, command } = detectBackend();
    info.backend = backend;
    info.command = command;
    // Backend version string, best-effort.
    if (backend === "scanimage") {
      const r = await runAsync(command, ["--version"], 8000);
      info.backendVersion = (r.out || r.err).split("\n")[0]?.trim();
    } else if (backend === "naps2") {
      const r = await runAsync(command, [...naps2Prefix(command), "--help"], 8000);
      info.backendVersion = (r.out.trim() || r.err).split("\n")[0]?.trim();
    }
    const started = Date.now();
    const list = await listDevices({ maxAgeMs: 0 });
    info.devices = list.devices;
    info.deviceCount = list.devices.length;
    info.listedInMs = Date.now() - started; // how slow listing is on this PC
    if (list.timedOut) info.listTimedOut = true;
    if (list.busy) info.listSkipped = "a scan is running";
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

function buildNaps2Args({ dir, mode, dpi, opts, noProfile }) {
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
  // NAPS2_PROFILE=<name>: scan with that profile from the NAPS2 window (for a
  // scanner that works there but not with default settings). Otherwise use
  // default settings, not whatever profile was last used in the window (that
  // profile can point at another driver/device).
  if (process.env.NAPS2_PROFILE) args.push("--profile", process.env.NAPS2_PROFILE);
  else if (noProfile) args.push("--noprofile");

  // Map our source names to NAPS2's (glass | feeder | duplex).
  const source = opts.source || (mode === "continuous" ? "feeder" : "glass");
  args.push("--source", source);

  if (device) args.push("--device", device);
  return args;
}

/**
 * Mock backend: copies the sample image (assets/sample-scan.jpeg) as 1 page (single)
 * or 3 pages (continuous) with a small delay, so the full UI works with no
 * hardware. Enable with MOCK=1.
 */
function runMock(dir, mode) {
  const sample = join(__dirname, "assets", "sample-scan.jpeg");
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
