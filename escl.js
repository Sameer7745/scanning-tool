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
import os from "node:os";
import { URL } from "node:url";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.js";
import { discoverEsclScanners } from "./discover.js";

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

/** This machine's IPv4 /24 subnets, e.g. [{ base:"192.168.1", self:"192.168.1.25" }]. */
function localSubnets() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === "IPv4" && !ni.internal) {
        const p = ni.address.split(".");
        out.push({ base: `${p[0]}.${p[1]}.${p[2]}`, self: ni.address });
      }
    }
  }
  return out;
}

/** Probe one IP for an eSCL scanner. Returns {ip,name,url} or null. */
async function probeEscl(ip, timeout = 1200) {
  const port = Number(process.env.SCANNER_PROBE_PORT) || 80; // 80 for real HP scanners
  const host = port === 80 ? ip : `${ip}:${port}`;
  try {
    const r = await request(`http://${host}/eSCL/ScannerStatus`, { timeout });
    if (r.status < 200 || r.status >= 500) return null;
    let name = `Scanner ${ip}`;
    try {
      const c = await request(`http://${host}/eSCL/ScannerCapabilities`, { timeout });
      const m = c.body.toString("utf8").match(/<pwg:MakeAndModel>([^<]+)</i);
      if (m) name = m[1].trim();
    } catch {}
    return { ip, name, url: `http://${host}/eSCL` };
  } catch {
    return null;
  }
}

/**
 * Scan the local subnet(s) for eSCL scanners by probing each host directly.
 * Does NOT use mDNS, so it works even where a system daemon owns port 5353.
 */
export async function scanSubnetForEscl(nameFilter = "", perHostTimeout = 1200) {
  const results = [];
  for (const { base } of localSubnets()) {
    const ips = [];
    for (let i = 1; i <= 254; i++) ips.push(`${base}.${i}`);
    const BATCH = 50;
    for (let i = 0; i < ips.length; i += BATCH) {
      const chunk = ips.slice(i, i + BATCH);
      const found = await Promise.all(chunk.map((ip) => probeEscl(ip, perHostTimeout)));
      for (const f of found) {
        if (!f) continue;
        if (nameFilter && !f.name.toLowerCase().includes(nameFilter.toLowerCase())) continue;
        results.push(f);
      }
    }
  }
  return results;
}

/**
 * Find scanners on the network: try mDNS first (fast when it works), then fall
 * back to a direct subnet scan (reliable everywhere). Returns [{name,ip,url}].
 */
export async function discoverScanners(nameFilter = "") {
  let list = [];
  try {
    list = await discoverEsclScanners(4000, nameFilter);
  } catch {}
  if (list.length) return list;
  log.debug("escl", "mDNS found nothing, scanning subnet…");
  return scanSubnetForEscl(nameFilter);
}

/** Quick reachability check for an eSCL base URL (true if the scanner answers). */
export async function esclReachable(base, timeout = 4000) {
  try {
    const r = await request(`${base}/ScannerStatus`, { timeout });
    return r.status >= 200 && r.status < 500; // any real HTTP reply = it's there
  } catch {
    return false;
  }
}

// Cache of the last discovered scanner URL, so we don't mDNS-browse every scan.
let _cache = { url: "", at: 0 };
const CACHE_MS = 60000;

/**
 * Figure out the scanner's CURRENT URL — resilient to IP changes.
 * Order:
 *   1. SCANNER_URL (an IP/host) if it's actually reachable.
 *   2. A recently-cached discovered URL if still reachable.
 *   3. mDNS discovery by name (SCANNER_NAME filters; else first scanner found).
 *   4. Fall back to SCANNER_URL even if unverified (last resort).
 * Returns a base like "http://192.168.1.42/eSCL", or "" if nothing is found.
 */
export async function resolveScannerUrl() {
  const explicit = process.env.SCANNER_URL;
  const isAuto = !explicit || explicit.toLowerCase() === "auto";
  const nameFilter = process.env.SCANNER_NAME || "";

  // 1. Honor an explicit IP/host if the scanner is actually there.
  if (!isAuto) {
    const base = esclBase(explicit);
    if (await esclReachable(base)) return base;
    log.warn("escl", "SCANNER_URL not reachable, trying discovery", base);
  }

  // 2. Reuse a recent discovery if it still answers.
  if (_cache.url && Date.now() - _cache.at < CACHE_MS && (await esclReachable(_cache.url))) {
    return _cache.url;
  }

  // 3. Discover on the network by name (when the IP changes, the name doesn't).
  const list = await discoverScanners(nameFilter);
  if (list.length) {
    _cache = { url: list[0].url, at: Date.now() };
    log.info("escl", "discovered scanner", { name: list[0].name, url: list[0].url });
    return list[0].url;
  }

  // 4. Last resort: return the configured URL even though it didn't answer.
  if (!isAuto) return esclBase(explicit);
  return "";
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
  let cancelled = false;

  const completed = (async () => {
    // 0. Resolve the scanner's CURRENT address (survives IP changes via mDNS).
    const base = await resolveScannerUrl();
    if (!base) {
      throw new Error(
        "No scanner found on the network. Is it powered on and on the same network as this computer?"
      );
    }
    log.debug("escl", "using scanner", base);

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
