import { useEffect, useRef, useState } from "react";

// When the page is served BY the bridge (one-process deploy), target the same
// host it was loaded from — so a customer opening http://scanner-pc-ip:3001
// just works. In Vite dev (port 5173) fall back to the bridge on :3001.
const DEFAULT_BRIDGE =
  typeof window !== "undefined" && window.location.port !== "5173"
    ? window.location.origin
    : "http://localhost:3001";

// Friendly names for common Tesseract language codes (Indian languages + more).
const LANG_NAMES = {
  eng: "English",
  hin: "Hindi",
  mar: "Marathi",
  san: "Sanskrit",
  guj: "Gujarati",
  ben: "Bengali",
  tam: "Tamil",
  tel: "Telugu",
  kan: "Kannada",
  mal: "Malayalam",
  pan: "Punjabi",
  ori: "Odia",
  urd: "Urdu",
  asm: "Assamese",
};

export default function App() {
  const [bridge, setBridge] = useState(
    () => localStorage.getItem("bridgeUrl") || DEFAULT_BRIDGE
  );
  const [health, setHealth] = useState(null); // {backend, platform, ocr, languages}
  const [devices, setDevices] = useState([]);
  const [device, setDevice] = useState("");
  const [dpi, setDpi] = useState(200);
  const [source, setSource] = useState("auto");
  const [mode, setMode] = useState("single");
  const [lang, setLang] = useState(() => localStorage.getItem("ocrLang") || "mar+hin+eng");
  const [ocrOn, setOcrOn] = useState(false); // OCR off by default — plain scanning
  const [pages, setPages] = useState([]); // [{uid,display,dataUrl,text}]
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false); // exporting PDF
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
    } catch {
      setError(
        `Could not reach the bridge at ${base}. Is the server running on the scanner machine and reachable over the network?`
      );
    }
  }

  useEffect(() => {
    checkConnection();
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
      setPages((prev) =>
        prev.map((p) => (p.uid === uid ? { ...p, text: d.text || "" } : p))
      );
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
        msg = "Lost connection to the bridge. Check the scanner is on and the server is running.";
      }
      setError(msg);
      stopScan();
    });
  }

  function stopScan() {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
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
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function downloadImage(dataUrl, name) {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = name;
    a.click();
  }

  function downloadPageText(p) {
    downloadBlob(new Blob([p.text || ""], { type: "text/plain" }), `scan-page-${p.display}.txt`);
  }

  function downloadCombinedText() {
    const all = pages
      .map((p) => `===== Page ${p.display} =====\n${p.text || ""}`)
      .join("\n\n");
    downloadBlob(new Blob([all], { type: "text/plain" }), "scan-all-pages.txt");
  }

  async function downloadSearchablePdf() {
    setBusy(true);
    setError("");
    setStatus("Building searchable PDF…");
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
    } finally {
      setBusy(false);
    }
  }

  function copyText(t) {
    navigator.clipboard?.writeText(t || "");
  }

  const backendLabel =
    health?.backend === "mock" ? "Mock (no scanner CLI)" : health?.backend || "—";
  const ocrReady = !!health?.ocr;
  const installed = health?.languages || [];
  const anyText = pages.some((p) => p.text);

  return (
    <div className="app">
      <header className="topbar">
        <h1>🖨️ Scan Tool</h1>
        <div className="conn">
          <input
            className="bridge-input"
            value={bridge}
            onChange={(e) => setBridge(e.target.value)}
            placeholder="http://scanner-machine-ip:3001"
            spellCheck={false}
          />
          <button onClick={checkConnection} className="btn ghost">Connect</button>
          <span className={`pill ${health ? "ok" : "bad"}`}>
            {health ? `${backendLabel} · ${health.platform}` : "not connected"}
          </span>
          <span className={`pill ${ocrReady ? "ok" : "bad"}`}>
            {ocrReady ? `OCR: ${installed.length} langs` : "OCR off"}
          </span>
        </div>
      </header>

      <section className="controls">
        <div className="field">
          <label>Scanner</label>
          <select value={device} onChange={(e) => setDevice(e.target.value)}>
            <option value="">Default device</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Source</label>
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="auto">Auto</option>
            <option value="glass">Flatbed (glass)</option>
            <option value="feeder">ADF (feeder)</option>
            <option value="duplex">ADF duplex</option>
          </select>
        </div>

        <div className="field">
          <label>Resolution (DPI)</label>
          <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
            {[100, 150, 200, 300, 600].map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="single">Single page</option>
            <option value="continuous">Continuous (ADF — all pages)</option>
          </select>
        </div>

        <div className="field">
          <label>OCR language</label>
          <select value={lang} onChange={(e) => setLang(e.target.value)} disabled={!ocrReady}>
            <option value="mar+hin+eng">Auto: Marathi + Hindi + English</option>
            {installed.map((code) => (
              <option key={code} value={code}>
                {LANG_NAMES[code] ? `${LANG_NAMES[code]} (${code})` : code}
              </option>
            ))}
          </select>
        </div>

        <div className="field check">
          <label>
            <input
              type="checkbox"
              checked={ocrOn && ocrReady}
              disabled={!ocrReady}
              onChange={(e) => setOcrOn(e.target.checked)}
            />{" "}
            Extract text (OCR)
          </label>
        </div>

        <div className="actions">
          {!scanning ? (
            <button className="btn primary" onClick={startScan} disabled={!health || busy}>
              ⏺ Scan
            </button>
          ) : (
            <button className="btn danger" onClick={stopScan}>■ Stop</button>
          )}
          <button className="btn ghost" onClick={clearPages} disabled={!pages.length || busy}>
            Clear
          </button>
          <button className="btn ghost" onClick={downloadCombinedText} disabled={!anyText || busy}>
            ⤓ Combined .txt
          </button>
          <button
            className="btn ghost"
            onClick={downloadSearchablePdf}
            disabled={!pages.length || !ocrReady || busy}
          >
            {busy ? "Building…" : "⤓ Searchable PDF"}
          </button>
        </div>
      </section>

      {status && <div className="status">{(scanning || busy) && <span className="spin" />} {status}</div>}
      {error && <div className="error">{error}</div>}

      <main className="gallery">
        {pages.length === 0 && !scanning && (
          <div className="empty">
            <p>No pages yet.</p>
            <p className="hint">
              Place a document on the scanner and press <b>Scan</b>. Each scan adds a
              page here with its recognized text — scan again to add more.
            </p>
          </div>
        )}
        {pages.map((p) => (
          <figure key={p.uid} className="card">
            <img src={p.dataUrl} alt={`Page ${p.display}`} />
            <figcaption>
              <span>Page {p.display}</span>
              <button className="btn tiny" onClick={() => downloadImage(p.dataUrl, `scan-page-${p.display}.jpg`)}>
                ⤓ img
              </button>
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
    </div>
  );
}
