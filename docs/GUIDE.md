# Scan Tool — Complete Guide (Simple Words)

This document explains **what this tool is, how it works, how to install it, and
how to fix common problems** — in plain language. Keep it with the project.

---

## 1. What this tool does

You click a **Scan** button on a web page, the document scanner scans the paper,
and the scanned image appears on the web page. You can keep scanning to add more
pages, and download them.

The scanner used in this project is an **HP Smart Tank 580-590 series** (a
flatbed all-in-one printer/scanner). It has **no automatic feeder**, so scanning
multiple pages means: scan one page → put the next page → scan again.

---

## 2. The most important idea (read this first)

**A web page by itself CANNOT talk to a scanner.** Web browsers are not allowed
to touch USB/scanner hardware — this is a built-in security rule in every
browser. There is no code or setting that changes this.

So we need **two parts**:

| Part | What it is | Where it runs |
|------|-----------|---------------|
| **Web UI** | The page with the Scan button | Anywhere (your server/VPS or the laptop) |
| **Bridge** | A small helper program that talks to the scanner | **Must run on the computer the scanner is connected to** |

The browser talks to the **Bridge**, and the Bridge talks to the **scanner**.

```
   [ Web page / Scan button ]  --->  [ Bridge program ]  --->  [ Scanner ]
         (in the browser)              (on the scanner PC)        (USB or WiFi)
```

> Every web-scanning product in the world works this way (HP's own tools,
> Dynamsoft, etc.). A small local helper is always required. This is normal.

---

## 3. The two folders in this project

| Folder | What it is | Runs where |
|--------|-----------|------------|
| **`server/`** | The **Bridge** (a small Node.js program) | On the PC/laptop with the scanner |
| **`web/`** | The **Web UI** (the page with the Scan button) | On your server/VPS, or the same laptop |

- `server/` finds the scanner and sends scanned images to the browser.
- `web/` is just the page the user sees.

---

## 4. How the Bridge reaches the scanner

The Bridge can reach the scanner in **two ways**, and it picks automatically:

1. **By USB** — the scanner is plugged into the same computer the Bridge runs on.
   - On **Windows**: install **NAPS2** (the Bridge uses it).
   - On **Mac**: install **NAPS2** (uses Apple's built-in scanning).
   - On **Linux**: install HP's driver (`hplip`) or **NAPS2**.

2. **By network (WiFi)** — the scanner is on WiFi and the Bridge computer is on
   the **same network**. The Bridge can talk to it directly by IP address, with
   **no drivers at all**, using one setting:
   ```
   SCANNER_URL=http://<scanner-ip>/eSCL
   ```

**Golden rule:** the Bridge computer must be able to reach the scanner — either
the scanner is **plugged into it by USB**, or they are **on the same network**.

---

## 5. Installation — the simple paths

Choose the one that matches your setup.

### ★ Recommended: the packaged app (no Node, one file)

The Bridge is also shipped as a **single executable** (Node is bundled inside),
so the client installs **nothing** except the scanner driver.

1. On the download page (`https://<your-domain>/download`) click **Download for
   your OS**, or copy the file from `binaries/` to the machine:
   - Windows → `ScanBridge-win-x64.exe`
   - macOS → `ScanBridge-macos-arm64` / `ScanBridge-macos-x64`
   - Linux → `ScanBridge-linux-x64`
2. **Run it.** On Windows, if "Windows protected your PC" appears, click
   **More info → Run anyway** (the app is unsigned).
3. What happens:
   - **No console window** — it runs in the background.
   - A **tray icon** appears (Windows notification area / macOS menu bar).
   - Your **browser opens automatically** to the panel (`http://localhost:3001`).
4. Install the scanner driver when prompted — click **Install NAPS2** in the
   panel (or install it yourself from naps2.com). You never *run* NAPS2; the
   Bridge calls it automatically when scanning.
5. Put a page on the scanner → **Scan**.

**Controlling the app (tray icon):** right-click the tray icon →
- **Open Scan Bridge** — open the panel
- **Quit Scan Bridge** — stop the app

You can also **Quit** from the panel (⚙ Bridge settings → ⏻ Quit Scan Bridge).

> Settings live in a `.env` file created **next to the executable** on first run
> (edit `SCAN_MODE`, `PORT`, etc., then restart the app).

### Updating an already-installed client

1. **Stop the running app** — right-click the tray icon → **Quit** (or in the
   panel, ⏻ Quit; or on Windows `taskkill /F /IM ScanBridge-win-x64.exe`).
   *(You must stop it first — a running exe locks the file and port 3001.)*
2. **Replace** the old executable with the new one.
3. **Run** the new executable. Done — the `.env` and settings are preserved.

### A) Scanner plugged into a Windows laptop (USB) — most common (manual/dev)

On that **laptop**:

1. Install **Node.js** — https://nodejs.org (download the "LTS" version).
2. Install **NAPS2** — https://www.naps2.com/download
3. Test that Windows can scan: open **"Windows Fax and Scan" → New Scan**.
   If that works, we're good. (If not, install the **HP Smart** app from the
   Microsoft Store so Windows sees the scanner.)
4. Copy the **`server/`** folder onto the laptop.
5. Open **Command Prompt** in that folder and run:
   ```cmd
   npm install
   npm start
   ```
6. You should see: `Detected backend: naps2`. The Bridge is now running at
   `http://localhost:3001`.
7. Open **`http://localhost:3001`** in the laptop's browser → click **Scan**.

That's it — scanning works.

### B) Scanner on WiFi, Bridge on a computer on the same network

1. Install **Node.js** on that computer.
2. Find the scanner's IP (print the printer's "Network Configuration Report",
   or check the router). Example: `192.168.1.36`.
3. Test it's reachable:
   ```
   curl http://192.168.1.36/eSCL/ScannerCapabilities
   ```
   (Should print XML.)
4. Start the Bridge pointed at the scanner:
   ```bash
   # Mac/Linux:
   SCANNER_URL=http://192.168.1.36/eSCL npm start
   # Windows (Command Prompt):
   set SCANNER_URL=http://192.168.1.36/eSCL
   npm start
   ```
5. Open `http://localhost:3001` → Scan.

> **Tip:** give the printer a fixed IP (a "DHCP reservation" on the router) so
> the address never changes.

---

## 6. "localhost" — what it means (this trips everyone up)

`localhost` always means **"the same computer the browser is running on."** It is
NOT the server, NOT a fixed machine.

- Open the page at `http://localhost:3001` on the laptop → it calls the Bridge on
  that same laptop → **works**.
- Open a page from a **public internet address** (like `http://194.195.112.236`)
  → the browser **blocks** it from calling `localhost` (a security rule called
  *Private Network Access*). The Bridge is fine; the browser refuses the call.

**Rule:** a web page may call the local Bridge **only if the page itself is
served over `https://` (a real domain with a certificate)**, or if you simply
open the page from `http://localhost:3001` directly.

```
Page from  http://localhost:3001            -> calls localhost -> WORKS
Page from  https://scanning-tool.accucia.co -> calls localhost -> WORKS (needs HTTPS)
Page from  http://194.195.112.236           -> calls localhost -> BLOCKED by browser
```

---

## 7. Putting the Web UI on a server (VPS) + your domain

If you want the page hosted on your server (e.g. inside your NestJS app) and the
Scan button to drive the **local** scanner, you MUST serve the site over
**HTTPS**. Here is the full setup for the domain `scanning-tool.accucia.co`.

**On the VPS:**

1. Build the Web UI:
   ```bash
   cd web
   npm install
   npm run build          # creates web/dist/
   ```
2. Serve it with PM2 (static server built into PM2):
   ```bash
   pm2 serve /var/www/nestjs/scanning-tool/web/dist 8080 --name scan-web --spa
   pm2 save
   pm2 startup            # run once, then run the command it prints
   ```
3. Point DNS: add an **A record** `scanning-tool.accucia.co -> <your VPS IP>`.
4. nginx reverse proxy:
   ```nginx
   # /etc/nginx/sites-available/scanning-tool
   server {
       listen 80;
       server_name scanning-tool.accucia.co;
       location / {
           proxy_pass http://localhost:8080;
           proxy_set_header Host $host;
       }
   }
   ```
   ```bash
   sudo ln -s /etc/nginx/sites-available/scanning-tool /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```
5. Add HTTPS (free certificate):
   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d scanning-tool.accucia.co
   ```

Now `https://scanning-tool.accucia.co` shows the UI over HTTPS.

**On the scanning laptop:** the Bridge must still be running (`server/`,
`npm start`), because the scanner is physically there.

**The full picture:**
```
  https://scanning-tool.accucia.co   (VPS: PM2 + nginx + HTTPS = the web page)
         |   opened in the browser ON the scanning laptop
         v   Scan button calls http://localhost:3001
   Bridge on the laptop (server/)  ------>  USB / WiFi scanner
```

> IMPORTANT: The VPS **cannot** reach the scanner (the scanner is on a private
> office network; the VPS is on the public internet). The VPS only serves the
> **page**. The **scanning** always happens through the Bridge on the local
> laptop. The user must open the site **on the laptop that has the scanner**.

---

## 8. Add the Scan button to your own web page

If you use your own page (not the bundled UI), add this:

```html
<button id="scanBtn">Scan</button>
<img id="scanImg" style="max-width:100%" />

<script>
const BRIDGE = "http://localhost:3001";   // the local Bridge on the scanning PC
document.getElementById("scanBtn").onclick = () => {
  const es = new EventSource(`${BRIDGE}/api/scan?mode=single&dpi=200&source=glass`);
  es.addEventListener("page", e => {                 // a page was scanned
    document.getElementById("scanImg").src = JSON.parse(e.data).dataUrl;
  });
  es.addEventListener("done",  () => es.close());
  es.addEventListener("error", () => { es.close(); alert("Scan failed — is the local Bridge running?"); });
};
</script>
```

---

## 9. Keep the Bridge always running

**Packaged app:** add the executable to startup so it launches on boot:
- **Windows:** put a shortcut to the exe in the Startup folder
  (`Win+R` → `shell:startup`), or add it to Task Scheduler "At log on".
- **macOS:** System Settings → General → Login Items → add the app.
- **Linux:** use the provided `deploy/scan-tool.service` (systemd).

It runs in the background with a tray icon; users control it from the tray.

**Dev/manual (running `server/` with Node):**
- **Windows:** shortcut to `scripts\start.bat`, or Task Scheduler "At log on".
- **Mac/Linux:** `deploy/scan-tool.service` (systemd), or PM2:
  ```bash
  pm2 start npm --name scan-bridge -- start   # run inside server/
  pm2 save
  ```

## 9b. Building the executables yourself

The build tooling lives in **`packaging/`**. From the repo root, on a machine
with internet:
```bash
npm run setup        # once: installs server/, web/ and packaging/
npm run exe:win      # -> binaries/ScanBridge-win-x64.exe (with icon)
#   npm run exe:mac / exe:linux / exe:all
```
The binaries are git-ignored (too large to commit). Full steps and
troubleshooting: `packaging/README.md`.

---

## 10. Settings — the `.env` file

The Bridge reads a **`server/.env`** file. Copy `server/.env.example` to
`server/.env`, edit it, and restart the Bridge. The main switch is `SCAN_MODE`:

```ini
# usb | wireless | auto
SCAN_MODE=usb                      # USB scanner (default) — nothing else needed

# For wireless, set SCAN_MODE=wireless and ONE of these:
# SCANNER_NAME=HP Smart Tank       # find by name (survives IP changes) — best
# SCANNER_URL=http://192.168.1.36/eSCL   # or a fixed address

PORT=3001
# OCR_ENABLED=1
# DEBUG=1
```

| Setting | What it does | Example |
|---------|--------------|---------|
| `SCAN_MODE` | `usb`, `wireless`, or `auto` | `SCAN_MODE=usb` |
| `SCANNER_NAME` | Wireless: find scanner by name (survives IP changes) | `SCANNER_NAME=HP Smart Tank` |
| `SCANNER_URL` | Wireless: pin a specific address | `SCANNER_URL=http://192.168.1.36/eSCL` |
| `PORT` | Port the Bridge listens on | `PORT=3001` |
| `OCR_ENABLED` | Turn on text extraction (off by default) | `OCR_ENABLED=1` |
| `DEBUG` / `LOG_FILE` | Verbose logging / log to a file | `DEBUG=1` |

> **USB now, wireless later:** keep `SCAN_MODE=usb`. When you move to WiFi,
> change it to `wireless`, set `SCANNER_NAME`, and restart — no code changes.

---

## 11. Troubleshooting (problems we actually hit)

**The downloaded exe says "corrupted and unreadable"**
- The real binary wasn't there yet, so the server sent the HTML page as the
  `.exe`. Make sure the actual binary is in the `downloads/` folder, and that
  Apache does **not** rewrite `/downloads/` to `index.html` (add
  `FallbackResource disabled` for that folder).

**The exe opened a window that flashed and closed**
- Old build (V8 bytecode mismatch from cross-compiling). The current builds use
  `--public` (plain source) and run fine. Use the latest binary.

**NAPS2 console windows kept popping up on Windows**
- Fixed in the current build (`windowsHide` on all scanner calls). Use the
  latest binary.

**The app runs but I can't find a window to close it**
- It's a background app. Right-click the **tray icon → Quit**, or use the
  panel's **⏻ Quit** button, or `taskkill /F /IM ScanBridge-win-x64.exe`.

**The hosted panel (`https://…`) shows "not connected"**
- The page must be **HTTPS** (browsers block a public page from calling
  `localhost` otherwise), and must be opened **on the same PC that runs the
  Bridge**. Quick test: open `http://localhost:3001` directly on that PC.

**"No SANE devices found"**
- This message comes from **Linux**. It means the Bridge is running on a Linux
  machine that can't see the scanner. The scanner is on the **laptop**, so run
  the Bridge on the **laptop** (Windows/Mac), not on the Linux server.

**"Could not reach the bridge at http://localhost:3001"**
- The Bridge isn't running on this computer → start it (`npm start` in `server/`).
- OR the page was opened from a **public http:// address** → the browser blocks
  the localhost call. Open `http://localhost:3001` directly, or serve the page
  over **HTTPS** (Section 7).

**`curl http://<ip>/eSCL/ScannerCapabilities` times out**
- The computer is **not on the same network** as the scanner. A cloud/VPS server
  can never reach an office scanner. Run the Bridge on a local office machine.

**Bridge says `backend: mock`**
- No scanner software found. Install **NAPS2** (Windows/Mac) or set `SCANNER_URL`.
  "mock" just uses a sample image so you can test the screens.

**Scanner seems "busy" / 503 for a while**
- This scanner handles one job at a time. The Bridge always finishes a job, so it
  clears itself in a few seconds. Just wait and scan again.

**Check everything at a glance**
- Open `http://localhost:3001/api/diagnostics` on the Bridge machine. It shows the
  detected scanner, the backend in use, and any errors.

---

## 12. Quick reference

| I want to… | Do this |
|------------|---------|
| Scan right now (laptop) | Run Bridge (`server/ npm start`), open `http://localhost:3001` |
| Use a network scanner by IP | `SCANNER_URL=http://<ip>/eSCL npm start` |
| Host the page on my server | Build `web/`, serve over **HTTPS** (domain + certbot), keep Bridge on the laptop |
| See what the scanner is doing | Open `/api/diagnostics`, or run with `DEBUG=1` |
| Turn on text recognition (OCR) | Start Bridge with `OCR_ENABLED=1` (needs Tesseract installed) |

---

## 13. One-line summary

**Host the web page anywhere (over HTTPS), but the little Bridge program must run
on the computer the scanner is attached to — the browser talks to that local
Bridge, and the Bridge talks to the scanner.**
