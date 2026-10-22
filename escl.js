// escl.js — direct eSCL (AirScan) client.
//
// Scans from ANY network scanner given just its URL (http://<ip>/eSCL) using
// Node's raw http/https — NO drivers, NO SANE, NO NAPS2. This is the simplest
// thing to deploy on a server: set SCANNER_URL and run.
//
// We use node:http (not fetch) on purpose: HP's embedded web server is picky
// about request framing, and the http module matches what curl sends (explicit
// Content-Length, no undici quirks).
//
// eSCL flow:
//   POST /eSCL/ScanJobs   (XML settings)      -> 201 + Location: <jobUrl>
//   GET  <jobUrl>/NextDocument                -> 200 image (one page), repeat
//                                             -> 404/410 when no pages left

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.js";

/** Low-level request. Returns { status, headers, body:Buffer }. */
function request(urlStr, { method = "GET", headers = {}, body = null, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + (u.search || ""),
      headers: { ...headers },
      timeout,
      rejectUnauthorized: false, // tolerate self-signed certs on https eSCL
    };
    if (body != null) opts.headers["Content-Length"] = Buffer.byteLength(body);
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      );
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    if (body != null) req.write(body);
    req.end();
    request._active = req; // for cancellation
  });
}

/** Normalize "ip", "http://ip", "http://ip/eSCL" -> "http://ip/eSCL". */
export function esclBase(url) {
  let u = String(url || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  u = u.replace(/\/+$/, "");
  if (!/\/eSCL$/i.test(u)) u += "/eSCL";
  return u;
}

/** Read scanner make/model via ScannerCapabilities. */
export async function esclCapabilities(url) {
  const b = esclBase(url);
  const r = await request(`${b}/ScannerCapabilities`, { timeout: 8000 });
  if (r.status !== 200) throw new Error(`ScannerCapabilities HTTP ${r.status}`);
  const xml = r.body.toString("utf8");
  const model = (xml.match(/<pwg:MakeAndModel>([^<]+)</i) || [])[1] || "eSCL scanner";
  const maker = (xml.match(/<scan:Manufacturer>([^<]+)</i) || [])[1] || "";
  return { model, maker, name: `${maker} ${model}`.trim(), base: b };
}

function scanSettingsXml({ dpi, source, width, height, color }) {
  const res = Number(dpi) > 0 ? Number(dpi) : 200;
  const input = source === "feeder" || source === "duplex" ? "Feeder" : "Platen";
  const w = Number(width) > 0 ? Number(width) : 2550; // 1/300 in (Letter width)
  const h = Number(height) > 0 ? Number(height) : 3508; // scanner max height
  const colorMode = color || "RGB24";
  const duplexLine = source === "duplex" ? "\n  <scan:Duplex>true</scan:Duplex>" : "";
  // Element order and ScanRegions follow the eSCL/Mopria schema that HP expects.
  return `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm" xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03">
  <pwg:Version>2.6</pwg:Version>
  <scan:Intent>Document</scan:Intent>
  <pwg:ScanRegions pwg:MustHonor="false">
    <pwg:ScanRegion>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
      <pwg:Width>${w}</pwg:Width>
      <pwg:Height>${h}</pwg:Height>
      <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <pwg:InputSource>${input}</pwg:InputSource>${duplexLine}
  <scan:ColorMode>${colorMode}</scan:ColorMode>
  <scan:XResolution>${res}</scan:XResolution>
  <scan:YResolution>${res}</scan:YResolution>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>
</scan:ScanSettings>`;
}

/**
 * Start an eSCL scan. Writes page-001.jpg, page-002.jpg ... into `dir` as pages
 * arrive. Returns { completed: Promise<pageCount>, cancel() }.
 */
export function startEsclScan(dir, opts = {}) {
  const base = esclBase(opts.url);
  let cancelled = false;

  const completed = (async () => {
    // 1. Create the scan job.
    const xml = scanSettingsXml(opts);
    const post = await request(`${base}/ScanJobs`, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: xml,
      timeout: 20000,
    });
    if (post.status !== 201) {
      const t = post.body.toString("utf8").slice(0, 160);
      throw new Error(`ScanJobs HTTP ${post.status}${t ? ": " + t : ""}`);
    }
    let jobUrl = post.headers.location;
    if (!jobUrl) throw new Error("Scanner did not return a job Location");
    if (!/^https?:/i.test(jobUrl)) {
      const origin = base.replace(/\/eSCL$/i, "");
      jobUrl = origin + (jobUrl.startsWith("/") ? "" : "/") + jobUrl;
    }
    log.debug("escl", "job created", jobUrl);

    // 2. Pull pages until the scanner reports no more (404/410). Platen returns
    //    one page then 404; Feeder returns pages until the tray is empty.
    let page = 0;
    let idleRetries = 0;
    while (!cancelled) {
      const nd = await request(`${jobUrl}/NextDocument`, { timeout: 60000 });
      if (nd.status === 200) {
        if (nd.body.length === 0) break;
        page += 1;
        const name = `page-${String(page).padStart(3, "0")}.jpg`;
        writeFileSync(join(dir, name), nd.body);
        log.info("escl", `page ${page} received`, { bytes: nd.body.length });
        idleRetries = 0;
      } else if (nd.status === 404 || nd.status === 410) {
        break; // job finished
      } else if (nd.status === 503) {
        if (++idleRetries > 40) throw new Error("Scanner stayed busy (503) too long");
        await new Promise((r) => setTimeout(r, 500));
      } else {
        throw new Error(`NextDocument HTTP ${nd.status}`);
      }
    }
    if (page === 0 && !cancelled) throw new Error("No pages were scanned");
    return page;
  })();

  return {
    completed,
    cancel: () => {
      cancelled = true;
      try {
        request._active?.destroy();
      } catch {}
    },
  };
}
