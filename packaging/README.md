# Packaging — building the Scan Bridge app (.exe)

Turns the bridge (`server/`) + the web UI (`web/dist`) into **one executable per
OS** (Windows / macOS / Linux) with **Node bundled inside**. The client runs one
file; no Node/npm install needed on their PC.

Everything for this lives in this folder:

| File | What it does |
|---|---|
| `build.mjs` | Bundles `server/` into one file and stages it with the web UI in `dist-bin/` |
| `pkg.mjs` | Turns `dist-bin/` into the executables in `../binaries/` (adds the icon on Windows) |
| `icon/scan-bridge.ico` | The exe icon (`.png` is a preview) |
| `icon/make-icon.mjs` | Draws the icon; also writes the tray icon (`server/icon.js`) |

## Make a new .exe (Windows)

You need **Node 18+** and **internet the first time** (pkg downloads a Node base
binary into `~/.pkg-cache`; later builds work offline). It can be built on
Windows, macOS or Linux.

Run these from the **repo root** (the folder with the top-level `package.json`):

```bash
# 1. Once (and again after pulling dependency changes):
npm run setup

# 2. Every time you want a new exe:
npm run exe:win
```

The new app is **`binaries/ScanBridge-win-x64.exe`**. `exe:win` does three
things in order, which you can also run one by one:

```bash
npm run build:web               # web/ -> web/dist
npm run bundle                  # server/ + web/dist -> packaging/dist-bin
node packaging/pkg.mjs win      # dist-bin -> binaries/ScanBridge-win-x64.exe
```

Other platforms: `npm run exe:mac`, `npm run exe:linux`, or `npm run exe:all`.

### Before you build

- **Bump the version** in `server/package.json` (e.g. `1.0.0` → `1.0.1`). It is
  shown in the exe's *Properties → Details*, so you can tell builds apart at the
  client.
- Code changes in `server/` or `web/` are picked up automatically; there is
  nothing else to edit.

### Install it at the client

1. Quit the old Scan Bridge (tray icon → *Quit*, or *Quit Scan Bridge* in the panel).
2. Replace the old `ScanBridge-win-x64.exe` with the new one and start it.
3. Keep the `.env` next to the exe, if there is one: it holds that PC's settings.

To also offer it on the download page, copy it into `web/public/downloads/`
and rebuild the web (`npm run build:web`).

## Changing the icon

Edit the colours/shapes in `icon/make-icon.mjs`, then:

```bash
npm run icon       # rewrites icon/scan-bridge.ico, .png and server/icon.js
npm run exe:win
```

Or drop your own multi-size `icon/scan-bridge.ico` in place (skip `npm run
icon`, which would overwrite it).

How it's applied: pkg can't set an icon, and editing the finished exe would
break it (pkg records where its payload sits). So `pkg.mjs` copies pkg's
Windows Node base binary, sets the icon and file details on that copy
(`packaging/.cache/`), and builds from it via `PKG_NODE_PATH`. If that step
fails, the build carries on without the icon and says so.

## Troubleshooting

| Message | Fix |
|---|---|
| `web/dist is missing` | Run `npm run build:web` first (`exe:win` does this for you) |
| `dist-bin/bridge.cjs missing` | Run `npm run bundle` first |
| `failed to build win (needs network…)` | Connect to the internet once so pkg can download its base binary |
| `Cannot resolve 'mod'` / `Dynamic require may fail` | Harmless warning from a dependency; the build still succeeds |
| Windows SmartScreen warns about the exe | Expected: the exe isn't code-signed. *More info → Run anyway* |

`dist-bin/`, `.cache/` and `../binaries/` are build output and git-ignored.

## The portable fallback (no pkg)

`dist-bin/bridge.cjs` is a **single self-contained JS bundle** (all npm deps
inlined). On any machine that has Node installed you can run it directly:

```bash
node packaging/dist-bin/bridge.cjs   # serves UI + API on :3001, uses ./web and ./.env
```
