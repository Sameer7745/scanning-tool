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

// Load .env (next to the binary/app) before anything reads process.env.
import dotenv from "dotenv";
import { ENV_FILE, ensureEnvFile, findWebDist, PACKAGED } from "./runtime.js";
import { spawn as _spawn } from "node:child_process";
import { startTray } from "./tray.js";
ensureEnvFile();
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
import { detectBackend, listDevices, startScan, diagnostics, resetBackendCache } from "./scanner.js";
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

app.use(cors());

// Private Network Access: when a page on a public/remote origin (e.g. your VPS
// app) calls this local bridge, Chrome sends a preflight asking permission to
// reach a private/localhost address. Acknowledge it so the call isn't blocked.
// (Chrome still requires the calling PAGE to be HTTPS — serve your app over
// https for this to take effect.)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "*");
    return res.sendStatus(204);
  }
  next();
});

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
    const d = listDevices();
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
      const { devices } = listDevices();
      out.connected = devices.length > 0;
      out.scanner = devices[0]?.name || null;
      out.detail = out.connected ? "USB scanner detected" : "no USB scanner detected";
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
  const d = diagnostics();
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

app.get("/api/scan", (req, res) => {
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

  let session;
  try {
    session = startScan(opts);
  } catch (e) {
    log.error("scan", "startScan threw", String(e.message || e));
    send("error", { message: String(e.message || e) });
    return res.end();
  }

  const { dir, backend, child, mock, escl, command, args } = session;
  // The single most useful line for debugging a scanner problem:
  log.info("scan", `backend=${backend} cmd`, [command, ...(args || [])].join(" "));
  send("status", { backend, mode: opts.mode, message: "Scanning…" });

  // --- Watch the temp dir and stream each completed page file ---
  const sent = new Set();
  const sizes = new Map();
  let pageIndex = 0;
  let stderr = "";
  let finished = false;

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

  const finish = (errMessage) => {
    if (finished) return;
    finished = true;
    clearInterval(poll);
    // Final sweep in case the last page settled between polls.
    readStable();
    setTimeout(() => {
      readStable();
      if (errMessage && pageIndex === 0) {
        log.error("scan", "failed", { message: errMessage, stderr: stderr.trim() || undefined });
        send("error", { message: errMessage });
      } else {
        log.info("scan", "done", { pages: pageIndex });
        send("done", { count: pageIndex });
      }
      res.end();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }, 400);
  };

  if (child) {
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      log.error("scan", "spawn error", err.message);
      finish(`Failed to launch scanner: ${err.message}`);
    });
    child.on("close", (code) => {
      // scanimage ADF batch exits non-zero with "out of documents" after the
      // LAST page — that's success, not an error, when we already got pages.
      const benign =
        /out of documents|no more documents|Document feeder out of documents/i.test(
          stderr
        );
      log.debug("scan", `process closed code=${code}`, { benign, pages: pageIndex, stderr: stderr.trim() || undefined });
      if (code !== 0 && !benign && pageIndex === 0) {
        finish(stderr.trim() || `Scanner exited with code ${code}`);
      } else {
        finish();
      }
    });
  } else if (escl) {
    // Direct eSCL network scan: finish when the HTTP job completes.
    escl.completed
      .then(() => finish())
      .catch((e) => finish(String(e && e.message ? e.message : e)));
  } else if (mock) {
    // Mock backend: finish shortly after the last simulated page lands.
    setTimeout(finish, (mock.totalApprox + 1) * 1300 + 1000);
  } else {
    finish("No scan process started.");
  }

  // Client disconnected -> kill the scan.
  req.on("close", () => {
    if (finished) return;
    finished = true;
    clearInterval(poll);
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
