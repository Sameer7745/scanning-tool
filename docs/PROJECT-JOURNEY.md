# Project Journey — How this tool was built (conversation record)

A plain-language record of the whole conversation: what was asked, what we
decided, what we built, the problems we hit, and how we solved them. Read
`GUIDE.md` for the actual how-to; this file is the "story and reasoning".

---

## The original request
> "Make a web page with a Scan button. On click, it scans the file and loads it
> on the web page. Use React. Also support continuous scanning (multiple pages)
> getting data from the scanner to the web page."

The scanner in the photo was identified as an **HP ScanJet Enterprise Flow
9000 s1**, but the user later clarified their real device is an **HP Smart Tank
580-590 series** (flatbed, no automatic feeder).

## Key decisions made up front
- **Multi-OS**, **free/open-source only**, **real scanner** integration.
- Architecture: a **React web UI** + a **Node.js "bridge" server** that drives the
  scanner, because browsers cannot access scanners directly.
- Pages stream to the web page one-by-one using Server-Sent Events (SSE).

## What was built
- **`server/`** — the bridge. Auto-detects a scanner backend:
  - `SCANNER_URL` (direct eSCL over the network, no drivers) →
  - **NAPS2** (Windows/Mac/Linux) →
  - **SANE `scanimage`** (Linux/Mac) →
  - **mock** (sample image, for testing with no hardware).
- **`web/`** — the React (Vite) UI: Scan button, device/DPI/source/mode pickers,
  a live gallery that fills page-by-page, and download buttons.
- **Single process option** — the bridge can also serve the built web UI, so one
  command and one URL (`http://localhost:3001`).

## OCR (text extraction) — added, then turned off
- We added optional OCR with **Tesseract** (all languages, incl. Marathi, Hindi,
  English and other Indian languages): per-page text, combined `.txt`, and a
  searchable PDF. Verified working.
- The user decided they didn't need it, so OCR was made **off by default**
  (enable with `OCR_ENABLED=1`). The code and languages stay installed but dormant.

## Making it deployable for a customer
- Added `DEPLOY.md`, `start.sh`, `start.bat` (now in `docs/` and `scripts/`), and a systemd unit
  (`deploy/scan-tool.service`).
- The UI auto-targets the bridge; default bridge URL is `http://localhost:3001`.

## Debugging tools (for on-site support)
- Leveled logging (`DEBUG=1`, `LOG_FILE=...`) that prints the **exact scan command**
  and the scanner's errors.
- A **`/api/diagnostics`** endpoint showing backend, version, detected devices
  (with IPs), OCR status, and errors.
- Crash logging so the bridge never dies silently.

## The direct-by-IP (eSCL) breakthrough
- The user asked "does it work with just the IP?" — yes. We built a **direct eSCL
  client** (pure Node HTTP) so the bridge can scan from a network scanner given
  only `SCANNER_URL=http://<ip>/eSCL`, with **no drivers at all**.
- First attempt failed (`ScanJobs HTTP 400`) because the scan-settings XML was too
  minimal; fixed by adding the proper `ScanRegions`/`Intent`. Then it failed from
  Node but worked from `curl` — the cause was Node's `fetch` framing; switching to
  Node's raw `http` module fixed it. **Verified: a real page scanned over the
  network using only the IP.**

## The big realization — where the bridge must run
Testing on the user's **Linux VPS** (`194.195.112.236`) revealed:
- `scanimage` found nothing; `curl` to the scanner **timed out**.
- Diagnostics showed the server is a **cloud VPS** with a **public IP**, not on the
  office network.

**Conclusion:** a cloud server can **never** reach a scanner on a private office
network. The bridge **must run on a machine inside the office/LAN** — ideally the
laptop the scanner is plugged into. The VPS only serves the web page.

## The "localhost" and HTTPS lesson
- The user deployed the web page on the VPS and saw "Could not reach the bridge at
  http://localhost:3001".
- Cause: `localhost` means **the browser's own computer**, and browsers **block a
  public http:// page from calling localhost** (Private Network Access).
- Opening `http://localhost:3001` directly on the laptop **works** (confirmed).
- To let the **VPS-hosted** page call the local bridge, the VPS site must be served
  over **HTTPS**. We added the `Access-Control-Allow-Private-Network` header to the
  bridge to support that case.

## Final deployment shape
```
  https://scanning-tool.accucia.co   (VPS: PM2 + nginx + HTTPS = the web page)
         |   opened in the browser ON the scanning laptop
         v   Scan button calls http://localhost:3001
   Bridge on the laptop (server/)  ------>  USB / WiFi scanner
```
- **VPS:** build `web/`, serve `web/dist` via `pm2 serve ... 8080 --spa`, put nginx
  + Let's Encrypt HTTPS in front for `scanning-tool.accucia.co`.
- **Laptop:** run the bridge (`server/`, `npm start`), scanner attached by USB (or
  on the same WiFi with `SCANNER_URL`).
- **User:** opens the HTTPS site **on the laptop with the scanner**.

## Status at the end
- Scanning verified working end-to-end via `http://localhost:3001` on the laptop.
- Remaining step for full integration: serve the VPS site over HTTPS (domain
  `scanning-tool.accucia.co` + certbot), then the hosted Scan button drives the
  local scanner.

See **`GUIDE.md`** for step-by-step installation and **`DEPLOY.md`** for per-OS
server setup.
