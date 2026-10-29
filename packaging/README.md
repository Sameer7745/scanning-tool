# Build the Scan Bridge executables (on your server)

Turns this `server/` code + the web UI into **one executable per OS** with Node
bundled inside — the client runs one file, no Node install.

## Prerequisites
- Node.js (18+) on the build machine, with **internet** (pkg downloads prebuilt
  Node base binaries the first time).
- This `server/` folder with its deps installed: from `server/`, run `npm install`.
- The built web UI (`web/dist`). Build it in the web repo: `npm run build`.

## Build

```bash
cd server/packaging
npm install                        # once (esbuild + pkg)

# point at your built web UI (or rely on the default ../../web/dist)
WEB_DIST=/path/to/web/dist npm run bundle

# produce the executables into ./out  (or set OUT_DIR)
node pkg.mjs                        # all: win, mac-arm, mac-x64, linux
#   node pkg.mjs win                # just one
#   OUT_DIR=/path/to/web/dist/downloads node pkg.mjs   # write straight to downloads
```

Output (in `./out` by default):
- `ScanBridge-win-x64.exe`
- `ScanBridge-macos-arm64`
- `ScanBridge-macos-x64`
- `ScanBridge-linux-x64`

**Copy these into your server's web `downloads/` folder manually.** They are
intentionally git-ignored (large binaries aren't committed).

## Notes
- Base binaries are cached in `~/.pkg-cache` after the first download, so later
  builds are fast.
- The client machine still needs the scanner backend installed: **NAPS2**
  (Windows/macOS) or SANE/hplip (Linux), and **Tesseract** only if using OCR.
- Each executable serves the UI on `http://localhost:3001` and writes a `.env`
  next to itself (edit it to change `SCAN_MODE`, `PORT`, …).
- `dist-bin/` is an intermediate staging folder (git-ignored).
