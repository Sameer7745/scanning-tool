// config.js — read and update the bridge's settings (.env) at runtime, so the
// control UI can switch scan mode / scanner without editing files or restarting.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { ENV_FILE as ENV_PATH } from "./runtime.js";

/** Current settings as seen by the running bridge. */
export function getConfig() {
  return {
    scanMode: (process.env.SCAN_MODE || "auto").toLowerCase(), // usb|wireless|auto
    scannerName: process.env.SCANNER_NAME || "",
    scannerUrl: process.env.SCANNER_URL || "",
    port: Number(process.env.PORT) || 3001,
    ocr: process.env.OCR_ENABLED === "1",
  };
}

/**
 * Update settings: applies to the live process immediately (detectBackend reads
 * process.env on each call) AND persists to .env so it survives a restart.
 * Accepts { scanMode, scannerName, scannerUrl }. Returns the new config.
 */
export function setConfig(updates = {}) {
  const map = {};
  if (updates.scanMode !== undefined) {
    const m = String(updates.scanMode).toLowerCase();
    map.SCAN_MODE = ["usb", "wireless", "auto"].includes(m) ? m : "auto";
  }
  if (updates.scannerName !== undefined) map.SCANNER_NAME = String(updates.scannerName).trim();
  if (updates.scannerUrl !== undefined) map.SCANNER_URL = String(updates.scannerUrl).trim();

  // Apply live.
  for (const [k, v] of Object.entries(map)) {
    if (v === "") delete process.env[k];
    else process.env[k] = v;
  }
  persistEnv(map);
  return getConfig();
}

/** Rewrite .env, updating the given keys and preserving everything else. */
function persistEnv(map) {
  let lines = [];
  if (existsSync(ENV_PATH)) lines = readFileSync(ENV_PATH, "utf8").split("\n");
  const seen = new Set();
  const out = lines.map((line) => {
    // Match "KEY=" or commented "# KEY=".
    const m = line.match(/^\s*#?\s*([A-Z_]+)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(map, m[1])) {
      seen.add(m[1]);
      const v = map[m[1]];
      return v === "" ? `# ${m[1]}=` : `${m[1]}=${v}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(map)) {
    if (!seen.has(k) && v !== "") out.push(`${k}=${v}`);
  }
  writeFileSync(ENV_PATH, out.join("\n"));
}
