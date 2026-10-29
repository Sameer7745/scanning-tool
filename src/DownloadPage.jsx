import { useEffect, useState } from "react";

const OS_LABEL = {
  windows: "Windows", "macos-arm64": "macOS (Apple Silicon)",
  "macos-x64": "macOS (Intel)", linux: "Linux",
};
const OS_ICON = { windows: "⊞", "macos-arm64": "", "macos-x64": "", linux: "🐧" };
const FALLBACK = {
  windows: "ScanBridge-win-x64.exe",
  "macos-arm64": "ScanBridge-macos-arm64",
  "macos-x64": "ScanBridge-macos-x64",
  linux: "ScanBridge-linux-x64",
};

function detectOS() {
  const ua = (navigator.userAgent || "").toLowerCase();
  const plat = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "").toLowerCase();
  if (plat.includes("win") || ua.includes("windows")) return "windows";
  if (plat.includes("mac") || ua.includes("macintosh") || ua.includes("mac os")) return "macos-arm64";
  if (plat.includes("linux") || ua.includes("linux") || ua.includes("x11")) return "linux";
  return "windows";
}

export default function DownloadPage() {
  const [dl, setDl] = useState(null);
  const os = detectOS();

  useEffect(() => {
    fetch("/downloads/manifest.json").then((r) => (r.ok ? r.json() : null)).then(setDl).catch(() => {});
  }, []);

  const fileFor = (k) => `/downloads/${dl?.files?.[k]?.file || FALLBACK[k]}`;

  return (
    <div className="dlpage">
      <header className="dl-topbar">
        <div className="brand">
          <span className="logo">🖨</span>
          <div><h1>Scan Bridge</h1><p>by Accucia Softwares</p></div>
        </div>
        <a className="btn ghost" href="/">Open panel →</a>
      </header>

      <section className="dl-hero">
        <div className="dl-hero-badge">Download</div>
        <h2>Install Scan Bridge on the computer with the scanner</h2>
        <p>
          A small app that lets this website scan from your document scanner.
          Install it once — it runs quietly in the background and starts on boot.
        </p>

        <a className="btn primary xl" href={fileFor(os)} download>
          ⬇ Download for {OS_LABEL[os]}
        </a>

        <div className="dl-alts">
          <span>Other systems:</span>
          {Object.keys(OS_LABEL).filter((k) => k !== os).map((k) => (
            <a key={k} href={fileFor(k)} download>{OS_LABEL[k]}</a>
          ))}
        </div>
      </section>

      <section className="dl-steps">
        <div className="step"><span className="n">1</span><div><h3>Download &amp; run</h3><p>Open the downloaded app. On Windows, if a security notice shows, click <b>More info → Run anyway</b>.</p></div></div>
        <div className="step"><span className="n">2</span><div><h3>Install the scanner driver</h3><p>If prompted, click <b>Install NAPS2</b> in the panel (or it runs in sample mode until you do).</p></div></div>
        <div className="step"><span className="n">3</span><div><h3>Scan</h3><p>The panel opens automatically. Put a page on the scanner and press <b>Scan</b>.</p></div></div>
      </section>

      <footer className="app-footer">
        <span className="fdot" /> Powered by{" "}
        <a href="https://www.accucia.com/" target="_blank" rel="noopener noreferrer">Accucia Softwares</a>
      </footer>
    </div>
  );
}
