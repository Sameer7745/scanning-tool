// tray.js — system-tray icon with Open / Quit, so the background app is
// controllable without Task Manager. Fully graceful: if the tray can't start,
// the bridge keeps running normally.

import SysTrayPkg from "systray2";
import { ICON_PNG, ICON_ICO } from "./icon.js";
import { log } from "./logger.js";

const SysTray = SysTrayPkg.default || SysTrayPkg;

export function startTray({ onOpen, onQuit } = {}) {
  try {
    const icon = process.platform === "win32" ? ICON_ICO : ICON_PNG;
    const itemOpen = { title: "Open Scan Bridge", tooltip: "Open the panel", enabled: true };
    const itemQuit = { title: "Quit Scan Bridge", tooltip: "Stop Scan Bridge", enabled: true };
    const SEP = SysTray.separator || { title: "<SEPARATOR>", enabled: false };

    const systray = new SysTray({
      menu: {
        icon,
        isTemplateIcon: false,
        title: "",
        tooltip: "Scan Bridge — running",
        items: [itemOpen, SEP, itemQuit],
      },
      debug: false,
      copyDir: true, // copy the helper binary out of the packaged snapshot to run it
    });

    // ready() spawns the helper; onClick/onError must be attached AFTER it.
    systray
      .ready()
      .then(() => {
        systray.onClick((action) => {
          const t = action?.item?.title;
          if (t === itemOpen.title) onOpen && onOpen();
          else if (t === itemQuit.title) {
            try { systray.kill(false); } catch {}
            onQuit && onQuit();
          }
        });
        if (systray.onError) systray.onError((e) => log.warn("tray", "error", String(e)));
        log.info("tray", "system tray started");
      })
      .catch((e) => log.warn("tray", "could not start tray", String(e.message || e)));

    return systray;
  } catch (e) {
    log.warn("tray", "tray unavailable — running without it", String(e.message || e));
    return null;
  }
}
