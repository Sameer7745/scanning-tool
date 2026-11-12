// index.js — local scanner bridge HTTP server.
//
// Runs on the machine the scanner is plugged into (USB) or reachable from
// (WiFi/eSCL). The React page talks to it over HTTP.
//
//   GET /api/health              -> { ok, backend, platform }
//   GET /api/devices             -> { backend, devices: [{id,name}] }
//   GET /api/scan?mode=&dpi=&source=&device=   (Server-Sent Events)
//        streams: event "page"  data {index, name, dataUrl}
//                 event "done"  data {count}
//                 event "error" data {message}

// Load .env (next to the binary/app) IF it exists — never create one. The app
// runs on built-in defaults (SCAN_MODE auto/usb, PORT 3001); a .env is written
// only if someone changes a setting from the panel.
import dotenv from "dotenv";
import { ENV_FILE, findWebDist, PACKAGED } from "./runtime.js";
import { spawn as _spawn } from "node:child_process";
import { startTray } from "./tray.js";
dotenv.config({ path: ENV_FILE });

import express from "express";
import cors from "cors";
import {
  readdirSync,
  readFileSync,
  statSync,
  rmSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectBackend,
  listDevices,
  cachedDevices,
  resetDeviceCache,
  scanStarted,
  scanEnded,
  startScan,
  diagnostics,
  resetBackendCache,
  rememberAutoSource,
  fallbackSource,
  otherDriverDevice,
  preferDevice,
} from "./scanner.js";
import { resolveScannerUrl, esclReachable, discoverScanners } from "./escl.js";
import { getConfig, setConfig } from "./config.js";
import { setupInfo, runInstall } from "./setup.js";
import {
  ocrAvailable,
  installedLanguages,
  ocrImageToText,
  buildSearchablePdf,
} from "./ocr.js";
import { log } from "./logger.js";

const app = express();
const PORT = process.env.PORT || 3001;

// Private Network Access: a page on a public/HTTPS origin (the VPS panel) calling
// this local bridge triggers a PNA preflight for the "loopback address space".
// The ACK header MUST be set BEFORE cors() answers the OPTIONS preflight, or the
// preflight response lacks it and the browser denies the request.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  // Newer Chrome "Local Network Access" spelling (harmless if unused):
  res.setHeader("Access-Control-Allow-Local-Network", "true");
  next();
});

app.use(cors());
app.options(/.*/, cors()); // make sure every OPTIONS preflight is answered (with the PNA header above)

app.use(express.json({ limit: "80mb" })); // scanned images are large

// Request logging (debug level, so production stays quiet unless DEBUG=1).
app.use((req, _res, next) => {
  log.debug("http", `${req.method} ${req.url}`);
  next();
});

// OCR is OFF by default (plain image scanning). To enable it, start the bridge
// with OCR_ENABLED=1. This keeps `npm start` a plain scanner on every OS.
const OCR_ENABLED = process.env.OCR_ENABLED === "1";

app.get("/api/health", (_req, res) => {
  const { backend } = detectBackend();
  const ocr = OCR_ENABLED && ocrAvailable();
  res.json({
    ok: true,
    backend,
    platform: process.platform,
    ocr,
    languages: ocr ? installedLanguages() : [],
  });
});

app.get("/api/devices", async (_req, res) => {
  try {
    const { backend } = detectBackend();
    if (backend === "escl") {
      // Discover live scanners on the network (finds the current IP).
      const list = await discoverScanners(process.env.SCANNER_NAME || "");
      const devices = list.map((s) => ({ id: s.url, name: `${s.name} (${s.ip})` }));
      // If none discovered but a URL is configured, still offer it.
      if (!devices.length) {
        const url = await resolveScannerUrl();
        if (url) devices.push({ id: url, name: `Network scanner (${url})` });
      }
      log.debug("devices", `escl discovered ${devices.length}`, devices);
      return res.json({ backend, devices });
    }
    const d = await listDevices();
    log.debug("devices", `found ${d.devices?.length || 0}`, d.devices);
    res.json(d);
  } catch (e) {
    log.error("devices", "listing failed", String(e.message || e));
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Bridge control UI endpoints ---

// Current settings (scan mode, scanner name/url, port).
app.get("/api/config", (_req, res) => res.json(getConfig()));

// Change settings (scan mode / scanner). Takes effect immediately + persists.
app.post("/api/config", (req, res) => {
  try {
    const cfg = setConfig(req.body || {});
    log.info("config", "updated", cfg);
    res.json(cfg);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// Shut the bridge down from the UI (so users don't need Task Manager, and can
// replace the app). Responds first, then exits.
app.post("/api/quit", (_req, res) => {
  log.info("quit", "shutdown requested from the panel");
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 300);
});

// Is the scanner backend (NAPS2/SANE) installed, and can we auto-install it?
app.get("/api/setup", (_req, res) => res.json(setupInfo()));

// Auto-install the scanner backend (winget/brew). Returns when done.
app.post("/api/setup/install", (_req, res) => {
  const info = setupInfo();
  if (info.installed) return res.json({ ok: true, alreadyInstalled: true });
  if (!info.canAutoInstall) {
    return res.status(400).json({ ok: false, error: "No automatic installer available — install manually.", manualUrl: info.manualUrl });
  }
  log.info("setup", `auto-installing ${info.pkg} via ${info.method}`);
  runInstall((err, result) => {
    if (err) {
      log.error("setup", "install failed", String(err.message || err));
      return res.status(500).json({ ok: false, error: String(err.message || err) });
    }
    resetBackendCache(); // re-detect NAPS2 right away after installing it
    const after = setupInfo();
    log.info("setup", "install finished", { code: result.code, installed: after.installed });
    res.json({ ok: after.installed || result.code === 0, installed: after.installed, backend: after.backend, output: result.output });
  });
});

// The panel gives up on a status check after 12 s; the first listing can take longer.
const FIRST_LIST_WAIT_MS = 8000;

// Live connection status for the UI: is a scanner connected right now?
app.get("/api/status", async (_req, res) => {
  const { backend } = detectBackend();
  const mode = (process.env.SCAN_MODE || "auto").toLowerCase();
  const out = { backend, mode, connected: false, scanner: null, detail: "" };
  try {
    if (backend === "escl") {
      const url = await resolveScannerUrl();
      out.connected = url ? await esclReachable(url) : false;
      out.scanner = url || null;
      out.detail = out.connected ? "reachable" : "no scanner found on the network";
    } else if (backend === "naps2" || backend === "scanimage") {
      // Answer from the last device list; listDevices() refreshes it in the
      // background when it is old. Only the very first check waits for a listing,
      // and not longer than the panel does.
      const refresh = listDevices();
      const cached = cachedDevices();
      const list =
        cached && cached.backend === backend
          ? cached
          : await Promise.race([refresh, new Promise((r) => setTimeout(() => r(null), FIRST_LIST_WAIT_MS))]);
      if (!list) {
        out.detail = "still looking for the scanner…";
      } else if (list.busy) {
        out.connected = true;
        out.detail = "scanning";
      } else {
        out.connected = list.devices.length > 0;
        out.scanner = list.devices[0]?.name || null;
        out.detail = out.connected ? "USB scanner detected" : "no USB scanner detected";
        out.checkedAt = new Date(list.at).toISOString();
      }
    } else if (backend === "mock") {
      out.connected = true;
      out.scanner = "Mock scanner (sample image)";
      out.detail = "no scanner backend installed — mock mode";
    }
  } catch (e) {
    out.detail = String(e.message || e);
  }
  res.json(out);
});

// One-stop diagnostics: backend, version, detected devices, OCR, errors.
// Visit http://<server>:3001/api/diagnostics to see why scanning may be failing.
app.get("/api/diagnostics", async (_req, res) => {
  const d = await diagnostics();
  d.ocr = { available: ocrAvailable(), enabled: OCR_ENABLED };
  d.logLevel = log.level;
  // For the network backend, resolve the scanner's CURRENT address live so the
  // report is accurate even if the IP changed.
  if (d.backend === "escl") {
    try {
      const url = await resolveScannerUrl();
      d.scannerUrl = url || null;
      d.scannerReachable = url ? await esclReachable(url) : false;
      const discovered = await discoverScanners(process.env.SCANNER_NAME || "");
      d.discovered = discovered.map((s) => ({ name: s.name, ip: s.ip, url: s.url }));
    } catch (e) {
      d.scannerError = String(e.message || e);
    }
  }
  log.info("diag", "diagnostics requested", d);
  res.json(d);
});

// Build a single multi-page SEARCHABLE PDF from the scanned page images the
// client already holds. Body: { pages: [dataUrl, ...], lang: "mar+hin+eng" }.
app.post("/api/export/pdf", (req, res) => {
  if (!OCR_ENABLED) {
    return res.status(400).json({ error: "OCR is disabled on the server (set OCR_ENABLED=1 to allow)." });
  }
  if (!ocrAvailable()) {
    return res.status(400).json({ error: "OCR (tesseract) is not installed." });
  }
  const pages = Array.isArray(req.body?.pages) ? req.body.pages : [];
  const lang = req.body?.lang || "mar+hin+eng";
  if (!pages.length) return res.status(400).json({ error: "No pages provided." });

  const dir = mkdtempSync(join(tmpdir(), "pdf-"));
  try {
    const imgPaths = pages.map((dataUrl, i) => {
      const b64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, "");
      const p = join(dir, `p-${String(i + 1).padStart(3, "0")}.jpg`);
      writeFileSync(p, Buffer.from(b64, "base64"));
      return p;
    });
    const pdf = buildSearchablePdf(imgPaths, dir, lang);
    if (!pdf) {
      rmSync(dir, { recursive: true, force: true });
      return res.status(500).json({ error: "Failed to build searchable PDF." });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="scan-ocr.pdf"');
    res.send(readFileSync(pdf));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

// NAPS2 prints only errors when run without -v; drop its banner lines, if any.
function scannerMessage(text) {
  return String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^NAPS2 \d|^Copyright /i.test(l))
    .join(" ")
    .slice(0, 400);
}

// NAPS2's TWAIN error text means little to a clerk; say what to check, keep the original.
function friendlyScanError(message) {
  if (/TWAIN error|No scanned pages to export/i.test(message)) {
    return (
      "The scanner's TWAIN driver returned no pages. Check the letter is in the feeder (face up) or on the glass, " +
      "close HP Scan / HP Smart if open, wake the scanner (press a button on it), then scan again. " +
      "If it keeps happening, install HP's full driver for this scanner (it adds the WIA driver). " +
      `(Scanner said: ${message})`
    );
  }
  return message;
}

// "Device not found"-style errors: the cached device list is wrong, list again.
const DEVICE_GONE = /could not be found|no device was specified|no scanner|device.*(not found|offline|disconnected)/i;

app.get("/api/scan", async (req, res) => {
  // --- Set up Server-Sent Events ---
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const opts = {
    mode: req.query.mode === "continuous" ? "continuous" : "single",
    dpi: req.query.dpi,
    source: req.query.source || undefined,
    device: req.query.device || undefined,
  };
  // OCR runs automatically server-side ONLY when enabled (OCR_ENABLED=1) and the
  // client asks (ocr=1). Off by default, so scanning just returns images.
  const ocrOn = OCR_ENABLED && req.query.ocr === "1" && ocrAvailable();
  const lang = req.query.lang || "mar+hin+eng";

  log.info("scan", "start", { mode: opts.mode, dpi: opts.dpi, source: opts.source, device: opts.device, ocr: ocrOn });

  let clientGone = false;
  res.on("close", () => (clientGone = true));

  let session;
  try {
    session = await startScan(opts);
  } catch (e) {
    log.error("scan", "startScan threw", String(e.message || e));
    if (DEVICE_GONE.test(String(e.message || e))) resetDeviceCache();
    send("error", { message: String(e.message || e) });
    return res.end();
  }
  if (clientGone) {
    try {
      session.child?.kill();
      session.mock?.cancel();
      session.escl?.cancel();
      rmSync(session.dir, { recursive: true, force: true });
    } catch {}
    return;
  }
  // While scanning, status checks answer from the cache (a busy scanner lists as absent).
  scanStarted();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    scanEnded();
  };

  // The running attempt. Source "auto" may need a second attempt from the other
  // source (a feeder-only scanner has no glass), so these change on a retry.
  let { dir, backend, child, mock, escl } = session;
  let retried = false;
  let switchedDriver = false;
  const firstAutoSource = session.autoSource;
  // The single most useful line for debugging a scanner problem:
  const logCmd = (s) => log.info("scan", `backend=${s.backend} cmd`, [s.command, ...(s.args || [])].join(" "));
  logCmd(session);
  send("status", { backend, mode: opts.mode, message: "Scanning…" });

  // --- Watch the temp dir and stream each completed page file ---
  const sent = new Set();
  const sizes = new Map();
  let pageIndex = 0;
  let stderr = "";
  let finished = false;
  // The error of every failed attempt: the retry's own error is often less telling.
  const attemptErrors = [];

  const readStable = () => {
    let files;
    try {
      files = readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort();
    } catch {
      return;
    }
    for (const f of files) {
      if (sent.has(f)) continue;
      const full = join(dir, f);
      let size;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      // Only emit once the file size is stable between polls (fully written).
      const prev = sizes.get(f);
      if (prev === undefined || prev !== size || size === 0) {
        sizes.set(f, size);
        continue;
      }
      try {
        const buf = readFileSync(full);
        if (buf.length === 0) continue;
        sent.add(f);
        pageIndex += 1;
        const idx = pageIndex;
        log.info("scan", `page ${idx} captured`, { name: f, bytes: buf.length });
        send("page", {
          index: idx,
          name: f,
          dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`,
        });
        // OCR the page (if enabled) and stream the text as a follow-up event,
        // so the image shows immediately and text fills in when ready.
        if (ocrOn) {
          send("status", { backend, mode: opts.mode, message: `Reading text on page ${idx}…` });
          const text = ocrImageToText(full, lang);
          send("text", { index: idx, name: f, text });
        }
      } catch {
        /* retry next tick */
      }
    }
  };

  const poll = setInterval(readStable, 300);

  const hasPages = () => {
    try {
      return pageIndex > 0 || readdirSync(dir).some((f) => /\.jpe?g$/i.test(f));
    } catch {
      return pageIndex > 0;
    }
  };

  const finish = (errMessage) => {
    if (finished) return;
    finished = true;
    clearInterval(poll);
    release();
    // Final sweep in case the last page settled between polls.
    readStable();
    setTimeout(() => {
      readStable();
      if (pageIndex === 0 && backend !== "mock") {
        if (errMessage) attemptErrors.push(errMessage);
        // Prefer a message from the scanner over our generic "exited with code N".
        const telling = attemptErrors.filter((m) => !/^Scanner exited with code/.test(m));
        const message =
          telling[telling.length - 1] ||
          attemptErrors[attemptErrors.length - 1] ||
          "No pages were scanned. Put the letter in the feeder (or on the glass) and scan again.";
        if (attemptErrors.some((m) => DEVICE_GONE.test(m))) resetDeviceCache();
        log.error("scan", "failed", { message, attempts: attemptErrors, stderr: stderr.trim() || undefined });
        send("error", { message: friendlyScanError(message) });
      } else {
        // An "auto" scan that worked: use this source first for this scanner next time.
        if (pageIndex > 0 && session.autoSource) rememberAutoSource(session.deviceKey, session.autoSource);
        // Scanned through the other driver: use it first from now on.
        if (pageIndex > 0 && switchedDriver && session.device) preferDevice(session.device);
        log.info("scan", "done", { pages: pageIndex });
        send("done", { count: pageIndex });
      }
      res.end();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }, 400);
  };

  // One attempt has ended. An "auto" scan that produced no page is tried once
  // more from the other source (glass <-> feeder); on Windows, a scan that still
  // got nothing is then tried through the other driver (TWAIN <-> WIA).
  const attemptEnded = async (errMessage) => {
    if (finished) return;
    if (hasPages()) return finish(errMessage);
    const gone = DEVICE_GONE.test(errMessage || "");
    let nextOpts;
    let nextAuto;
    let statusMessage;
    if (session.autoSource && !retried && !gone) {
      // No point trying the other source when the scanner itself wasn't found.
      retried = true;
      nextAuto = fallbackSource(session.autoSource);
      nextOpts = { ...opts, device: session.device || opts.device, source: nextAuto };
      statusMessage =
        nextAuto === "feeder" ? "No flatbed found. Scanning from the document feeder…" : "Feeder is empty. Scanning from the flatbed…";
      log.info("scan", `no pages from ${session.autoSource}, retrying from ${nextAuto}`, {
        error: errMessage || undefined,
        stderr: stderr.trim() || undefined,
      });
    } else if (!switchedDriver && session.device && backend === "naps2") {
      switchedDriver = true;
      const other = await otherDriverDevice(session.device);
      if (finished) return;
      if (other) {
        // Start over from the first source, and allow its glass <-> feeder retry.
        nextAuto = firstAutoSource;
        nextOpts = { ...opts, device: other, source: opts.source || firstAutoSource };
        retried = !firstAutoSource;
        statusMessage = "Trying the scanner's other driver…";
        log.info("scan", `no pages from ${session.device}, retrying with ${other}`, { error: errMessage || undefined });
      }
    }
    if (!nextOpts) return finish(errMessage);
    if (errMessage) attemptErrors.push(errMessage);
    const deviceKey = nextOpts.device === session.device ? session.deviceKey : nextAuto ? `naps2:${nextOpts.device}` : undefined;
    let again;
    try {
      again = await startScan(nextOpts);
    } catch (e) {
      return finish(String(e.message || e));
    }
    if (finished) {
      // The client went away while the retry was starting.
      try {
        again.child?.kill();
        again.escl?.cancel();
        rmSync(again.dir, { recursive: true, force: true });
      } catch {}
      return;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
    // Remember the fallback under the auto key if it works.
    session = { ...again, device: again.device || nextOpts.device, autoSource: nextAuto, deviceKey };
    ({ dir, backend, child, mock, escl } = again);
    stderr = "";
    sent.clear();
    sizes.clear();
    logCmd(again);
    send("status", { backend, mode: opts.mode, message: statusMessage });
    watch();
  };

  // Wires the current attempt's process / job to attemptEnded.
  const watch = () => {
    if (child) {
      const proc = child;
      let output = "";
      proc.stdout.on("data", (d) => (output += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("error", (err) => {
        log.error("scan", "spawn error", err.message);
        if (proc === child) finish(`Failed to launch scanner: ${err.message}`);
      });
      proc.on("close", (code) => {
        if (proc !== child) return; // a cancelled attempt
        // scanimage ADF batch exits non-zero with "out of documents" after the
        // LAST page — that's success, not an error, when we already got pages.
        const benign =
          /out of documents|no more documents|Document feeder out of documents/i.test(
            stderr
          );
        log.debug("scan", `process closed code=${code}`, { benign, pages: pageIndex, stdout: output.trim() || undefined, stderr: stderr.trim() || undefined });
        // NAPS2 reports most errors ("The selected scanner could not be found.")
        // on stdout and still exits 0, so any text with no pages is an error too.
        const message = scannerMessage(stderr) || scannerMessage(output);
        if (pageIndex === 0 && !benign && (code !== 0 || message)) {
          attemptEnded(message || `Scanner exited with code ${code} without saying why.`);
        } else {
          attemptEnded();
        }
      });
    } else if (escl) {
      // Direct eSCL network scan: finish when the HTTP job completes.
      const job = escl;
      job.completed
        .then(() => job === escl && attemptEnded())
        .catch((e) => job === escl && attemptEnded(String(e && e.message ? e.message : e)));
    } else if (mock) {
      // Mock backend: finish shortly after the last simulated page lands.
      setTimeout(finish, (mock.totalApprox + 1) * 1300 + 1000);
    } else {
      finish("No scan process started.");
    }
  };
  watch();

  // Client disconnected -> kill the scan.
  req.on("close", () => {
    if (finished) return;
    finished = true;
    clearInterval(poll);
    release();
    try {
      if (child) child.kill();
      if (mock) mock.cancel();
      if (escl) escl.cancel();
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
});

// --- Serve the built web UI (web/dist) if it exists, so the customer runs ONE
// process and opens ONE URL (http://localhost:3001). Falls back silently to
// API-only mode (dev uses the Vite server on :5173 instead).
const WEB_DIST = findWebDist();
const hasBuiltUI = !!WEB_DIST;
if (hasBuiltUI) {
  app.use(express.static(WEB_DIST));
  // SPA fallback: anything not under /api returns index.html.
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(WEB_DIST, "index.html")));
}

// Don't let an unexpected error silently kill the bridge — log it loudly.
process.on("uncaughtException", (err) => {
  log.error("fatal", "uncaughtException", err?.stack || String(err));
});
process.on("unhandledRejection", (reason) => {
  log.error("fatal", "unhandledRejection", String(reason));
});

app.listen(PORT, () => {
  const { backend } = detectBackend();
  console.log(`\n  Scanner bridge running:  http://localhost:${PORT}`);
  if (hasBuiltUI) console.log(`  Open the app at:         http://localhost:${PORT}`);
  console.log(`  Scan mode:               ${(process.env.SCAN_MODE || "auto").toLowerCase()}`);
  console.log(`  Detected backend:        ${backend}  (platform: ${process.platform})`);
  console.log(
    `  OCR:                     ${OCR_ENABLED ? "enabled" : "disabled (plain image scanning)"}`
  );
  console.log(`  Logging:                 level=${log.level}${process.env.LOG_FILE ? ` file=${process.env.LOG_FILE}` : ""}`);
  console.log(`  Diagnostics:             http://localhost:${PORT}/api/diagnostics`);
  if (backend === "mock") {
    console.log(
      `  NOTE: no scanner CLI found — running in MOCK mode (uses the sample image).`
    );
    console.log(
      `        Install NAPS2 (naps2.com) or SANE 'scanimage' on the scanner machine for real scans.\n`
    );
  } else {
    console.log("");
  }
  log.info("startup", "bridge ready", { port: PORT, backend, ocr: OCR_ENABLED, ui: hasBuiltUI });

  // Open the panel in the default browser.
  const url = `http://localhost:${PORT}`;
  const openPanel = () => {
    try {
      if (process.platform === "win32") _spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      else if (process.platform === "darwin") _spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      else _spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    } catch {}
  };

  // Auto-open on launch (packaged app by default; OPEN_BROWSER=0 to disable).
  const shouldOpen =
    process.env.OPEN_BROWSER === "1" || (PACKAGED && process.env.OPEN_BROWSER !== "0");
  if (shouldOpen && hasBuiltUI) openPanel();

  // System-tray icon (Open / Quit). On for the packaged app; TRAY=1 to force in
  // dev, TRAY=0 to disable. Never fatal if it can't start.
  if (process.env.TRAY === "1" || (PACKAGED && process.env.TRAY !== "0")) {
    startTray({ onOpen: openPanel, onQuit: () => process.exit(0) });
  }
});
