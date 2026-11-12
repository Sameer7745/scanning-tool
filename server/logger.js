// logger.js — tiny leveled logger for the bridge.
//
//   Levels: error < warn < info < debug
//   Control with env:
//     LOG_LEVEL=debug|info|warn|error   (default: info; or DEBUG=1 => debug)
//     LOG_FILE=/path/to/scan-tool.log    (also append logs to this file)
//
// Every line is timestamped and tagged, so an on-site operator can tail the log
// and see exactly which scan command ran and what the scanner returned.

import { appendFileSync } from "node:fs";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const level =
  process.env.LOG_LEVEL?.toLowerCase() ||
  (process.env.DEBUG === "1" ? "debug" : "info");
const threshold = LEVELS[level] ?? LEVELS.info;
const LOG_FILE = process.env.LOG_FILE || "";

function ts() {
  // Local ISO-ish timestamp without pulling in a date lib.
  return new Date().toISOString();
}

function write(lvl, tag, msg, extra) {
  if ((LEVELS[lvl] ?? 99) > threshold) return;
  let line = `${ts()} [${lvl.toUpperCase()}] ${tag ? tag + ": " : ""}${msg}`;
  if (extra !== undefined) {
    try {
      line += " " + (typeof extra === "string" ? extra : JSON.stringify(extra));
    } catch {
      line += " [unserializable]";
    }
  }
  const sink = lvl === "error" ? console.error : console.log;
  sink(line);
  if (LOG_FILE) {
    try {
      appendFileSync(LOG_FILE, line + "\n");
    } catch {
      /* best-effort file logging */
    }
  }
}

export const log = {
  level,
  error: (tag, msg, extra) => write("error", tag, msg, extra),
  warn: (tag, msg, extra) => write("warn", tag, msg, extra),
  info: (tag, msg, extra) => write("info", tag, msg, extra),
  debug: (tag, msg, extra) => write("debug", tag, msg, extra),
};
