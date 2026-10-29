import { useEffect, useRef, useState } from "react";

// The scan bridge runs as a LOCAL agent on the PC doing the scanning, so the
// default is always http://localhost:3001 — even when this page is served from a
// remote server (VPS). Browsers allow an HTTPS page to call http://localhost.
const DEFAULT_BRIDGE = "http://localhost:3001";

const LANG_NAMES = {
  eng: "English", hin: "Hindi", mar: "Marathi", san: "Sanskrit", guj: "Gujarati",
  ben: "Bengali", tam: "Tamil", tel: "Telugu", kan: "Kannada", mal: "Malayalam",
  pan: "Punjabi", ori: "Odia", urd: "Urdu", asm: "Assamese",
};

const OS_LABEL = {
  windows: "Windows", "macos-arm64": "macOS (Apple Silicon)",
  "macos-x64": "macOS (Intel)", linux: "Linux",
};
// Used if the downloads manifest can't be fetched.
const FALLBACK_DL = {
  windows: "ScanBridge-win-x64.exe",
  "macos-arm64": "ScanBridge-macos-arm64",
  "macos-x64": "ScanBridge-macos-x64",
  linux: "ScanBridge-linux-x64",
};

// Detect the visitor's OS so we can offer the matching installer.
function detectOS() {
  const ua = (navigator.userAgent || "").toLowerCase();
  const plat = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "").toLowerCase();
  if (plat.includes("win") || ua.includes("windows")) return "windows";
  if (plat.includes("mac") || ua.includes("macintosh") || ua.includes("mac os")) return "macos-arm64";
  if (plat.includes("linux") || ua.includes("linux") || ua.includes("x11")) return "linux";
  return "windows";
}

export default function App() {
  const [bridge, setBridge] = useState(
    () => localStorage.getItem("bridgeUrl") || DEFAULT_BRIDGE
  );
  const [health, setHealth] = useState(null);
  const [devices, setDevices] = useState([]);
  const [device, setDevice] = useState("");
  const [dpi, setDpi] = useState(200);
  const [source, setSource] = useState("auto");
  const [mode, setMode] = useState("single");
  const [lang, setLang] = useState(() => localStorage.getItem("ocrLang") || "mar+hin+eng");
  const [ocrOn, setOcrOn] = useState(false);
  const [pages, setPages] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState(null);
  const [connState, setConnState] = useState(null);
  const [checking, setChecking] = useState(false);
  const [savingCfg, setSavingCfg] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [dl, setDl] = useState(null); // download manifest
  const detectedOS = useRef(detectOS()).current;
  const esRef = useRef(null);
  const pageCounter = useRef(0);
  const scanIndexToUid = useRef({});

  const base = bridge.replace(/\/+$/, "");

  useEffect(() => localStorage.setItem("bridgeUrl", bridge), [bridge]);
  useEffect(() => localStorage.setItem("ocrLang", lang), [lang]);

  async function checkConnection() {
    setError("");
    setHealth(null);
    try {
      const j = await fetch(`${base}/api/health`).then((x) => x.json());
      setHealth(j);
      const d = await fetch(`${base}/api/devices`).then((x) => x.json());
      setDevices(d.devices || []);
      const c = await fetch(`${base}/api/config`).then((x) => x.json());
      setCfg(c);
      refreshStatus();
    } catch {
      setError(`Could not reach the bridge at ${base}. Is the bridge app running on this machine?`);
      setConnState({ connected: false, detail: "bridge unreachable" });
    }
  }

  async function refreshStatus() {
    setChecking(true);
    try {
      const s = await fetch(`${base}/api/status`).then((x) => x.json());
      setConnState(s);
    } catch {
      setConnState({ connected: false, detail: "bridge unreachable" });
    } finally {
      setChecking(false);
    }
  }

  async function saveConfig(updates) {
    setSavingCfg(true);
    setError("");
    try {
      const c = await fetch(`${base}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      }).then((x) => x.json());
      setCfg(c);
      const d = await fetch(`${base}/api/devices`).then((x) => x.json());
      setDevices(d.devices || []);
      await refreshStatus();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSavingCfg(false);
    }
  }

  useEffect(() => {
    checkConnection();
    // Download manifest is served by the PAGE host (the VPS), so fetch it
    // relative — this works even when the local bridge isn't running yet.
    fetch("/downloads/manifest.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => setDl(m))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startScan() {
    setError("");
    setScanning(true);
    setStatus("Connecting to scanner…");
    scanIndexToUid.current = {};
    const params = new URLSearchParams({ mode, dpi: String(dpi) });
    if (source !== "auto") params.set("source", source);
    if (device) params.set("device", device);
    params.set("ocr", ocrOn ? "1" : "0");
    params.set("lang", lang);

    const es = new EventSource(`${base}/api/scan?${params.toString()}`);
    esRef.current = es;
    es.addEventListener("status", (ev) => setStatus(JSON.parse(ev.data).message || "Scanning…"));
    es.addEventListener("page", (ev) => {
      const d = JSON.parse(ev.data);
      pageCounter.current += 1;
      const n = pageCounter.current;
      const uid = `${Date.now()}-${n}`;
      scanIndexToUid.current[d.index] = uid;
      setPages((prev) => [...prev, { uid, display: n, dataUrl: d.dataUrl, text: null }]);
      setStatus(`Received page ${n}…`);
    });
    es.addEventListener("text", (ev) => {
      const d = JSON.parse(ev.data);
      const uid = scanIndexToUid.current[d.index];
      if (!uid) return;
      setPages((prev) => prev.map((p) => (p.uid === uid ? { ...p, text: d.text || "" } : p)));
    });
    es.addEventListener("done", (ev) => {
      const d = JSON.parse(ev.data);
      setStatus(d.count ? `Done — ${d.count} page(s) this scan.` : "Done.");
      stopScan();
    });
    es.addEventListener("error", (ev) => {
      let msg = "Scan failed.";
      try {
        if (ev.data) msg = JSON.parse(ev.data).message || msg;
      } catch {
        msg = "Lost connection to the bridge. Check the scanner is on and the bridge is running.";
      }
      setError(msg);
      stopScan();
    });
  }

  function stopScan() {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setScanning(false);
  }

  function clearPages() {
    setPages([]);
    pageCounter.current = 0;
    setStatus("");
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function downloadImage(dataUrl, name) {
    const a = document.createElement("a");
    a.href = dataUrl; a.download = name; a.click();
  }
  function downloadPageText(p) {
    downloadBlob(new Blob([p.text || ""], { type: "text/plain" }), `scan-page-${p.display}.txt`);
  }
  function downloadCombinedText() {
    const all = pages.map((p) => `===== Page ${p.display} =====\n${p.text || ""}`).join("\n\n");
    downloadBlob(new Blob([all], { type: "text/plain" }), "scan-all-pages.txt");
  }
  async function downloadSearchablePdf() {
    setBusy(true); setError(""); setStatus("Building searchable PDF…");
    try {
      const r = await fetch(`${base}/api/export/pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages: pages.map((p) => p.dataUrl), lang }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "PDF export failed");
      downloadBlob(await r.blob(), "scan-ocr.pdf");
      setStatus("Searchable PDF downloaded.");
    } catch (e) {
      setError(String(e.message || e));
    } finally { setBusy(false); }
  }
  function copyText(t) { navigator.clipboard?.writeText(t || ""); }

  const ocrReady = !!health?.ocr;
  const installed = health?.languages || [];
  const anyText = pages.some((p) => p.text);
  const connected = !!connState?.connected;
  const modeLabel = { usb: "USB", wireless: "Wireless", auto: "Auto" }[cfg?.scanMode] || "—";

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="logo">🖨</span>
          <div>
            <h1>Scan Bridge</h1>
            <p>{health ? `${health.backend} · ${health.platform}` : "connecting…"}</p>
          </div>
        </div>
        <span className={`badge ${connected ? "ok" : "bad"}`}>
          <span className="badge-dot" />
          {connected ? "Online" : "Offline"}
        </span>
      </header>

      {/* Install prompt — shown when the local bridge isn't reachable */}
      {!health && (
        <section className="card download-card">
          <div className="dl-head">
            <span className="dl-ico">⬇</span>
            <div>
              <h2>Install Scan Bridge on this computer</h2>
              <p>
                To scan, the small Scan Bridge app must run on the PC with the scanner.
                It installs once and starts automatically.
              </p>
            </div>
          </div>
          <div className="dl-actions">
            <a
              className="btn primary big"
              href={`/downloads/${(dl?.files?.[detectedOS]?.file) || FALLBACK_DL[detectedOS]}`}
              download
            >
              ⬇ Download for {OS_LABEL[detectedOS]}
            </a>
            <div className="dl-others">
              <span>Other systems:</span>
              {Object.keys(OS_LABEL)
                .filter((k) => k !== detectedOS)
                .map((k) => (
                  <a key={k} href={`/downloads/${(dl?.files?.[k]?.file) || FALLBACK_DL[k]}`} download>
                    {OS_LABEL[k]}
                  </a>
                ))}
            </div>
          </div>
        </section>
      )}

      {/* Status card */}
      <section className="card status-card">
        <div className={`status-ring ${connected ? "on" : "off"}`}>
          {checking ? "…" : connected ? "✓" : "!"}
        </div>
        <div className="status-body">
          <h2>
            {checking ? "Checking scanner…" : connected ? "Scanner connected" : "No scanner connected"}
          </h2>
          <p className="status-name">{connState?.scanner || connState?.detail || "—"}</p>
          <div className="status-meta">
            <span className="chip">Mode: {modeLabel}</span>
            {health && <span className="chip">{health.backend}</span>}
            {health && <span className="chip">{health.platform}</span>}
          </div>
        </div>
        <button className="btn ghost" onClick={refreshStatus} disabled={checking}>
          {checking ? "Checking…" : "↻ Check"}
        </button>
      </section>

      {/* Scan card */}
      <section className="card scan-card">
        <div className="scan-row">
          <div className="field">
            <label>Source</label>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="auto">Auto</option>
              <option value="glass">Flatbed</option>
              <option value="feeder">Feeder (ADF)</option>
              <option value="duplex">ADF duplex</option>
            </select>
          </div>
          <div className="field">
            <label>Resolution</label>
            <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
              {[100, 150, 200, 300, 600].map((v) => <option key={v} value={v}>{v} dpi</option>)}
            </select>
          </div>
          <div className="field">
            <label>Pages</label>
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="single">Single</option>
              <option value="continuous">Continuous (ADF)</option>
            </select>
          </div>
          {ocrReady && (
            <label className="toggle">
              <input type="checkbox" checked={ocrOn} onChange={(e) => setOcrOn(e.target.checked)} />
              <span>Extract text</span>
            </label>
          )}
        </div>

        <div className="scan-actions">
          {!scanning ? (
            <button className="btn primary big" onClick={startScan} disabled={!health || busy}>
              ⏺ Scan
            </button>
          ) : (
            <button className="btn danger big" onClick={stopScan}>■ Stop</button>
          )}
          <button className="btn ghost" onClick={clearPages} disabled={!pages.length || busy}>Clear</button>
          {anyText && (
            <button className="btn ghost" onClick={downloadCombinedText} disabled={busy}>⤓ .txt</button>
          )}
          {ocrReady && (
            <button className="btn ghost" onClick={downloadSearchablePdf} disabled={!pages.length || busy}>
              {busy ? "Building…" : "⤓ PDF"}
            </button>
          )}
        </div>

        {(status || error) && (
          <div className={`line ${error ? "err" : "info"}`}>
            {(scanning || busy) && !error && <span className="spin" />}
            {error || status}
          </div>
        )}
      </section>

      {/* Advanced / settings */}
      <section className="card settings-card">
        <button className="settings-toggle" onClick={() => setShowAdvanced((v) => !v)}>
          <span>⚙ Bridge settings</span>
          <span className="chev">{showAdvanced ? "▲" : "▼"}</span>
        </button>
        {showAdvanced && (
          <div className="settings-body">
            {cfg && (
              <div className="field">
                <label>Connection mode</label>
                <select
                  value={cfg.scanMode}
                  disabled={savingCfg}
                  onChange={(e) => saveConfig({ scanMode: e.target.value })}
                >
                  <option value="usb">USB (wired)</option>
                  <option value="wireless">Wireless (network)</option>
                  <option value="auto">Auto</option>
                </select>
              </div>
            )}
            {cfg && (cfg.scanMode === "wireless" || cfg.scanMode === "auto") && (
              <div className="field grow">
                <label>Scanner name (wireless)</label>
                <input
                  defaultValue={cfg.scannerName}
                  placeholder="e.g. HP Smart Tank"
                  disabled={savingCfg}
                  onKeyDown={(e) => { if (e.key === "Enter") saveConfig({ scannerName: e.target.value }); }}
                  onBlur={(e) => { if (e.target.value !== cfg.scannerName) saveConfig({ scannerName: e.target.value }); }}
                />
              </div>
            )}
            {devices.length > 1 && (
              <div className="field grow">
                <label>Device</label>
                <select value={device} onChange={(e) => setDevice(e.target.value)}>
                  <option value="">Default device</option>
                  {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
            )}
            {ocrReady && (
              <div className="field grow">
                <label>OCR language</label>
                <select value={lang} onChange={(e) => setLang(e.target.value)}>
                  <option value="mar+hin+eng">Auto: Marathi + Hindi + English</option>
                  {installed.map((c) => (
                    <option key={c} value={c}>{LANG_NAMES[c] ? `${LANG_NAMES[c]} (${c})` : c}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="field grow">
              <label>Bridge address</label>
              <div className="row">
                <input
                  value={bridge}
                  onChange={(e) => setBridge(e.target.value)}
                  spellCheck={false}
                  placeholder="http://localhost:3001"
                />
                <button className="btn ghost" onClick={checkConnection}>Reconnect</button>
              </div>
            </div>
            {savingCfg && <span className="chip">saving…</span>}
          </div>
        )}
      </section>

      {/* Gallery */}
      {pages.length > 0 && (
        <div className="gallery-head">
          <h3>Scanned pages ({pages.length})</h3>
        </div>
      )}
      <main className="gallery">
        {pages.length === 0 && !scanning && (
          <div className="empty">
            <div className="empty-ico">📄</div>
            <p className="empty-title">No pages yet</p>
            <p className="empty-sub">
              Place a document on the scanner and press <b>Scan</b>. Each scan adds a page here.
            </p>
          </div>
        )}
        {pages.map((p) => (
          <figure key={p.uid} className="page-card">
            <img src={p.dataUrl} alt={`Page ${p.display}`} />
            <figcaption>
              <span>Page {p.display}</span>
              <button className="btn tiny" onClick={() => downloadImage(p.dataUrl, `scan-page-${p.display}.jpg`)}>⤓</button>
            </figcaption>
            {ocrOn && ocrReady && (
              <div className="ocr">
                {p.text === null ? (
                  <div className="ocr-pending"><span className="spin" /> reading text…</div>
                ) : (
                  <>
                    <textarea readOnly value={p.text} placeholder="(no text found)" />
                    <div className="ocr-actions">
                      <button className="btn tiny" onClick={() => copyText(p.text)}>Copy</button>
                      <button className="btn tiny" onClick={() => downloadPageText(p)}>.txt</button>
                    </div>
                  </>
                )}
              </div>
            )}
          </figure>
        ))}
      </main>

      <footer className="app-footer">
        <span className="fdot" />
        Powered by{" "}
        <a href="https://www.accucia.com/" target="_blank" rel="noopener noreferrer">
          Accucia Softwares
        </a>
      </footer>
    </div>
  );
}
