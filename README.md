# Scan Tool

A React web page with a **Scan** button that drives a real document/photo
scanner and loads the scanned pages straight onto the page. Supports
**continuous / multi-page** scanning, and works with scanners on **any
machine** (Windows, macOS, or Linux).

Because browsers cannot talk to USB/TWAIN/network scanners directly, there are
two pieces:

```
  [ React web UI ]  ──HTTP/SSE──►  [ Node.js bridge server ]  ──►  [ scanner ]
   (any browser)                   (runs on / near the scanner)     (USB or WiFi)
```

- **`web/`** — React (Vite) front end. The bridge address is configurable in
  the UI, so one web app can talk to any scanner machine on the network.
- **`server/`** — the bridge. It auto-detects whichever free scanner CLI is
  installed and streams each scanned page back to the browser as it comes off
  the scanner.

## Folder structure

```
scannig-tool/
├── server/            the bridge (Node + Express): scanning, status, OCR
│   └── assets/        sample-scan.jpeg — the page mock mode returns
├── web/               the panel (React + Vite)
├── packaging/         builds the single-file apps (.exe etc.) — see packaging/README.md
│   └── icon/          the app icon and the script that draws it
├── binaries/          built apps land here (git-ignored)
├── deploy/            systemd unit for running the bridge on Linux
├── scripts/           start.sh / start.bat — install, build and start in one go
├── docs/              GUIDE, DEPLOY, END-USER-INSTALL, PROJECT-JOURNEY, images/
└── package.json       the commands below, run from this folder
```

## Commands (run from this folder)

| Command | What it does |
|---|---|
| `npm run setup` | Install everything (`server/`, `web/`, `packaging/`) — once |
| `npm start` | Start the bridge on `http://localhost:3001` |
| `npm run dev:server` / `npm run dev:web` | Develop with auto-reload (web on `:5173`) |
| `npm run build:web` | Build the panel into `web/dist` (the bridge serves it) |
| `npm run exe:win` | **Build a new Windows app** → `binaries/ScanBridge-win-x64.exe` |
| `npm run exe:mac` / `exe:linux` / `exe:all` | The same for other platforms |
| `npm run icon` | Redraw the app icon after editing `packaging/icon/make-icon.mjs` |

## Make a new .exe

```bash
npm run setup      # once
npm run exe:win    # -> binaries/ScanBridge-win-x64.exe, with the Scan Bridge icon
```

Needs internet the first time only. Bump `version` in `server/package.json`
first so builds can be told apart. Full steps, installing at the client, and
troubleshooting: **[packaging/README.md](packaging/README.md)**.

## Supported backends (free / open-source)

The bridge uses the first one it finds:

| Backend | Platforms | Install |
|---|---|---|
| **NAPS2** (`naps2` / `NAPS2.Console`) | Windows, macOS, Linux | https://www.naps2.com — supports TWAIN, WIA, **eSCL (network)**, SANE, Apple |
| **SANE** (`scanimage`) | macOS, Linux | `brew install sane-backends` (mac) · `apt install sane-utils sane-airscan` (Linux) |

If neither is installed, the bridge runs in **MOCK** mode (uses the bundled
sample image) so you can try the whole UI without hardware.

## Run it

**1. Start the bridge on the scanner machine:**

```bash
npm run setup             # once
npm start                 # real scanner (auto-detected)
# or, to try the UI with no scanner:
cd server && MOCK=1 npm start
```

The bridge listens on `http://0.0.0.0:3001` (reachable across your LAN).

**2. Start the web UI (any machine):**

```bash
npm run dev:web           # opens http://localhost:5173
```

**3. In the UI**, set the **bridge address** to the scanner machine, e.g.
`http://192.168.1.50:3001`, click **Connect**, then **Scan**.

## Your scanner: HP Smart Tank 580 / 590

- It's a **flatbed all-in-one with no ADF**, and it supports **eSCL
  (driverless network scanning)** over WiFi/USB.
- Best setup: install **NAPS2**, which auto-uses the **eSCL** driver — no HP
  drivers needed, and the scanner is reachable over WiFi from any machine
  running the bridge.
- Since there's no document feeder, **multi-page scanning = place a page →
  Scan → place the next page → Scan again.** Each scan appends a page to the
  gallery, so you build up a multi-page batch. (Use **Source: Flatbed**.)
- The **Continuous (ADF)** mode is for scanners that *do* have a feeder (like
  the HP ScanJet 9000 s1) — one click pulls every page from the tray.
- **No source sent (Auto):** the bridge tries the flatbed (feeder in
  Continuous mode). If that returns no page, it retries once from the other
  source, and remembers what worked for that scanner until the bridge restarts.
  A feeder-only scanner like the 9000 s1 therefore works with the default
  settings; only its first scan pays for the failed flatbed attempt.

## OCR (text extraction) — off by default

Scanning returns **plain images**. OCR is **disabled by default** (`npm start`
prints `OCR: disabled`). It is never a manual step — when enabled, the bridge
runs Tesseract on each page automatically.

To turn it on, start the bridge with OCR enabled:

```bash
npm run start:ocr          # or: OCR_ENABLED=1 npm start
```

With OCR on you get: recognized text beside each page, a combined `.txt`, and a
searchable PDF. Tesseract + all languages (English, Hindi, Marathi, and other
Indian languages) are already installed on this machine but stay dormant.

## How continuous / live streaming works

The `/api/scan` endpoint is a **Server-Sent Events** stream. The bridge writes
one JPEG per page into a temp folder and, as each page finishes, emits a
`page` event with the image. The browser appends it to the gallery
immediately — so you watch pages appear one by one during a batch.
