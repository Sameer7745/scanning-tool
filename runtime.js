// runtime.js — resolve paths whether running as plain Node (dev), as a bundled
// .cjs, or as a packaged single-file executable (pkg).
//
//   BUNDLE_DIR = where read-only assets live (the snapshot, when packaged)
//   APP_DIR    = a WRITABLE folder next to the running binary (for .env)

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

// pkg sets process.pkg; its snapshot is read-only, so writable files must sit
// next to the actual executable (process.execPath).
export const PACKAGED = !!process.pkg;
export const BUNDLE_DIR = here;
export const APP_DIR = PACKAGED ? dirname(process.execPath) : here;

/** Locate the built web UI across dev / bundled / packaged layouts. */
export function findWebDist() {
  const candidates = [
    join(BUNDLE_DIR, "web"), // packaged/bundled: ./web next to the entry
    join(BUNDLE_DIR, "..", "web", "dist"), // dev: server/../web/dist
  ];
  return candidates.find((p) => existsSync(join(p, "index.html"))) || null;
}

/** Path to the writable .env (next to the binary when packaged). */
export const ENV_FILE = join(APP_DIR, ".env");

/** On first run of a packaged build, create a default .env if none exists. */
export function ensureEnvFile() {
  if (existsSync(ENV_FILE)) return;
  const def = [
    "# Scan Bridge configuration (edit and restart).",
    "# usb | wireless | auto",
    "SCAN_MODE=usb",
    "PORT=3001",
    "# SCANNER_NAME=HP Smart Tank",
    "# OCR_ENABLED=1",
    "",
  ].join("\n");
  try {
    writeFileSync(ENV_FILE, def);
  } catch {
    /* read-only location — fall back to process env defaults */
  }
}
