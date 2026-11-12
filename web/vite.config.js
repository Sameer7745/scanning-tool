import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server is reachable on the LAN (host: true) so you can open the UI from
// any machine. The scanner bridge URL is configured at runtime in the UI, so
// no build-time proxy is required.
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
});
