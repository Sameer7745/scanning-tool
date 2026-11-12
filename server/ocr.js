// ocr.js — Tesseract OCR helpers.
//
// The scanner only produces an IMAGE. OCR (image -> text) is this software
// step. We shell out to the `tesseract` CLI, which supports Marathi (mar),
// Hindi (hin), English (eng) and many other Indian languages.

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TESS_CANDIDATES = [
  "tesseract",
  "/opt/homebrew/bin/tesseract",
  "/usr/local/bin/tesseract",
  "/usr/bin/tesseract",
];

let _cmd = null;
/** Resolve the tesseract binary once (or null if not installed). */
export function tesseractCmd() {
  if (_cmd !== null) return _cmd || null;
  for (const c of TESS_CANDIDATES) {
    const isPath = c.includes("/");
    if (isPath && !existsSync(c)) continue;
    const r = spawnSync(c, ["--version"], { timeout: 8000, windowsHide: true });
    if (!r.error && (r.status === 0 || r.status === null)) {
      _cmd = c;
      return c;
    }
  }
  _cmd = "";
  return null;
}

export function ocrAvailable() {
  return !!tesseractCmd();
}

/** Languages actually installed, as Tesseract codes (e.g. ["eng","hin","mar"]). */
export function installedLanguages() {
  const cmd = tesseractCmd();
  if (!cmd) return [];
  const r = spawnSync(cmd, ["--list-langs"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  const out = (r.stdout || "") + (r.stderr || "");
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !/^List of available/i.test(s));
}

/** Keep only languages that are installed, preserving order; fall back to eng. */
function sanitizeLang(lang) {
  const installed = new Set(installedLanguages());
  const wanted = String(lang || "mar+hin+eng")
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((l) => installed.has(l));
  if (wanted.length) return wanted.join("+");
  return installed.has("eng") ? "eng" : [...installed][0] || "eng";
}

/** OCR a single image file -> plain text. Returns "" on failure. */
export function ocrImageToText(imagePath, lang) {
  const cmd = tesseractCmd();
  if (!cmd) return "";
  const l = sanitizeLang(lang);
  const r = spawnSync(cmd, [imagePath, "stdout", "-l", l], {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  return (r.stdout || "").trim();
}

/**
 * Build ONE multi-page searchable PDF (image + invisible text layer) from a
 * list of image files. Tesseract does this natively when given a text file
 * that lists the image paths. Returns the output PDF path, or null on failure.
 */
export function buildSearchablePdf(imagePaths, outDir, lang) {
  const cmd = tesseractCmd();
  if (!cmd || !imagePaths.length) return null;
  const l = sanitizeLang(lang);
  const listFile = join(outDir, "images.txt");
  writeFileSync(listFile, imagePaths.join("\n"), "utf8");
  const outBase = join(outDir, "scan-ocr"); // tesseract appends .pdf
  const r = spawnSync(cmd, [listFile, outBase, "-l", l, "pdf"], {
    encoding: "utf8",
    timeout: 300000,
    windowsHide: true,
  });
  const pdf = `${outBase}.pdf`;
  if (r.status === 0 && existsSync(pdf)) return pdf;
  return null;
}
