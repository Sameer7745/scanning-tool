// discover.js — find eSCL (AirScan) scanners on the local network via mDNS.
//
// This is what makes the tool survive a scanner IP change: instead of trusting a
// fixed IP, we look up the scanner by its advertised name and use whatever IP it
// currently has. Works on Windows/macOS/Linux (pure JS, no system tools).

import { Bonjour } from "bonjour-service";
import { log } from "./logger.js";

/**
 * Browse for "_uscan._tcp" (eSCL) services for `timeoutMs`.
 * Returns [{ name, ip, port, rs, url }], e.g. url = "http://192.168.1.42/eSCL".
 * `nameFilter` (optional) keeps only scanners whose name contains that text.
 */
export function discoverEsclScanners(timeoutMs = 4000, nameFilter = "") {
  return new Promise((resolve) => {
    let bonjour;
    const found = new Map();
    try {
      bonjour = new Bonjour();
    } catch (e) {
      log.warn("discover", "mDNS init failed", String(e.message || e));
      return resolve([]);
    }

    let browser;
    const finish = () => {
      try { browser?.stop(); } catch {}
      try { bonjour.destroy(); } catch {}
      resolve([...found.values()]);
    };

    try {
      browser = bonjour.find({ type: "uscan" }, (svc) => {
        const ip = (svc.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
        if (!ip) return;
        if (nameFilter && !String(svc.name).toLowerCase().includes(nameFilter.toLowerCase())) return;
        // TXT record "rs" holds the eSCL resource path (usually "eSCL").
        const rs = (svc.txt && (svc.txt.rs || svc.txt.RS)) || "eSCL";
        const port = svc.port || 80;
        const portPart = port === 80 ? "" : `:${port}`;
        found.set(svc.name, {
          name: svc.name,
          ip,
          port,
          rs,
          url: `http://${ip}${portPart}/${rs.replace(/^\/+/, "")}`,
        });
      });
    } catch (e) {
      log.warn("discover", "mDNS browse failed", String(e.message || e));
      return finish();
    }

    setTimeout(finish, timeoutMs);
  });
}
