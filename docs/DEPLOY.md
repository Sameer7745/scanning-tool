# Deploying Scan Tool (customer install)

The bridge server runs on **one machine**. It must be able to reach the scanner
either over **USB** (plugged into that machine) or over the **network** (the
scanner on WiFi/LAN — the HP Smart Tank 580/590 supports driverless **eSCL**).

End users on other devices just open a browser — **they install nothing**.

The bridge serves the web UI itself, so there is **one process and one URL**:
`http://<server-ip>:3001`.

---

## Simplest deploy: point at the scanner by IP (no drivers)  ← recommended

The bridge can talk to the scanner **directly over the network (eSCL)** with
**zero drivers** — no SANE, no NAPS2, nothing but Node.js. Set one value:

```bash
# Linux/macOS
SCANNER_URL=http://192.168.1.36/eSCL npm start
# Windows (PowerShell)
$env:SCANNER_URL="http://192.168.1.36/eSCL"; npm start
```

That's the whole scanner setup. The only requirement is that the **server can
reach the scanner's IP** on the network. (Works for the HP Smart Tank 580/590
and any AirScan/eSCL scanner.)

### Finding & managing the scanner's IP on the customer site
1. **Find it** — any one of:
   - Print the printer's **Network Configuration Report** from its panel.
   - Check the **router's DHCP client list**.
   - From the server: `curl http://<ip>/eSCL/ScannerCapabilities` (expect HTTP 200).
2. **Keep it stable** — set a **DHCP reservation** (static IP) for the printer on
   the router so the address never changes. *Or* use its mDNS hostname instead of
   the IP, e.g. `SCANNER_URL=http://HPXXXXXX.local/eSCL`, which survives IP changes.
3. **Change it later** — just edit the `SCANNER_URL` value (env var or the
   systemd `Environment=` line) and restart. **No code change, no redeploy.**
4. **Verify** anytime at `http://<server>:3001/api/diagnostics`.

> If you prefer OS scanner drivers instead of the direct-IP method (e.g. the
> scanner is on USB), use the per-OS backends below. The bridge auto-detects:
> `SCANNER_URL` (eSCL) → NAPS2 → SANE `scanimage`.

## What to install, per server OS (driver-based alternative)

Install these only on the **server** (the machine running the bridge):

### Linux server
```bash
# 1. Node.js 18+
sudo apt install -y nodejs npm            # Debian/Ubuntu
#   (or: sudo dnf install -y nodejs npm   # Fedora/RHEL)

# 2. Scanner backend — SANE + the eSCL/AirScan driver (driverless network scan)
sudo apt install -y sane-utils sane-airscan avahi-daemon   # Debian/Ubuntu
#   (or: sudo dnf install -y sane-backends sane-airscan avahi)

# 3. Confirm the scanner is found (scanner must be on the same LAN)
scanimage -L
#   -> device `airscan:...HP Smart Tank 580-590...' is a eSCL HP Smart Tank ...
```
- **By IP (most reliable — recommended for a fixed install):** you don't need
  mDNS/Avahi at all. Pin the scanner's IP in `/etc/sane.d/airscan.conf`:
  ```
  [devices]
  "HP Smart Tank 580" = http://192.168.1.36/eSCL
  ```
  Then `scanimage -L` shows it and the bridge uses it. This works across
  subnets/VLANs and survives reboots. Give the printer a **static/reserved IP**
  (DHCP reservation on the router) so the address never changes.
  - You can confirm the scanner is reachable from the server with:
    `curl http://192.168.1.36/eSCL/ScannerCapabilities` (expect HTTP 200 + XML).
- **By auto-discovery:** if the server and scanner are on the same LAN, mDNS
  discovery works out of the box (that's what `avahi-daemon` is for) — no config.
- **USB to the Linux box instead?** install HP's Linux driver which provides the
  `hpaio` SANE backend: `sudo apt install -y hplip sane-utils`, then `scanimage -L`.

### Windows server
1. **Node.js LTS** — https://nodejs.org
2. **NAPS2** — https://www.naps2.com/download (gives `NAPS2.Console.exe`)
3. Scanner driver: USB usually works via the built-in **WIA** driver (Windows
   Update). If not, install the **HP Smart** app / HP full driver. Network
   scanning works driverless via NAPS2's **eSCL** driver.

### macOS server (already set up on this Mac)
1. **Node.js** — `brew install node`
2. **NAPS2** — `brew install --cask naps2` (uses the Apple/AirScan driver)

> The bridge auto-detects the backend: **NAPS2** if present, else SANE
> **`scanimage`**. On a headless Linux server, SANE + `sane-airscan` is the
> lightweight choice and needs no GUI.

---

## Run it

```bash
# one-time: build the UI and install deps, then start (Linux/macOS)
./scripts/start.sh
#   Windows: double-click scripts\start.bat
```
Then open **`http://<server-ip>:3001`** from any device on the network.
(Scanning from the webpage runs on the server, so phones/laptops need nothing.)

## Keep it running on boot (Linux)
Use the provided systemd unit — see `deploy/scan-tool.service` for steps:
```bash
cd web && npm install && npm run build      # build UI once
sudo cp deploy/scan-tool.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now scan-tool
systemctl status scan-tool
```

---

## Client devices (everyone else)
**Nothing to install.** Open `http://<server-ip>:3001` in any browser. The UI
auto-targets the server it was loaded from, so there's nothing to configure.

## Notes
- **OCR is off by default** (plain image scanning). To enable it on the server,
  start with `OCR_ENABLED=1` and install Tesseract (`sudo apt install -y
  tesseract-ocr tesseract-ocr-all` on Linux). See README "OCR" section.
- **Firewall:** allow inbound TCP **3001** on the server for other devices to
  reach it.
- The Smart Tank 580/590 is **flatbed (no ADF)**: multi-page = scan a page,
  swap it, scan again — each scan adds a page in the gallery.
