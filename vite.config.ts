/// <reference types="vitest/config" />
import { cpSync, createReadStream, existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const PDFJS_ASSETS: [string, string][] = [
  ["node_modules/pdfjs-dist/cmaps", "cmaps"],
  ["node_modules/pdfjs-dist/standard_fonts", "standard_fonts"],
];

/** Serve pdf.js cmaps and standard fonts in dev, and copy them into dist. */
function pdfjsAssets(): Plugin {
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        for (const [from, prefix] of PDFJS_ASSETS) {
          const marker = `/${prefix}/`;
          const idx = url.indexOf(marker);
          if (idx === -1) continue;
          const rel = decodeURIComponent(url.slice(idx + marker.length));
          if (rel.includes("..")) break;
          const root = resolve(from);
          const file = resolve(root, rel);
          if (file !== root && !file.startsWith(root + sep)) break;
          if (!existsSync(file) || !statSync(file).isFile()) break;
          if (file.endsWith(".bcmap")) res.setHeader("Content-Type", "application/octet-stream");
          else if (file.endsWith(".ttf") || file.endsWith(".pfb") || file.endsWith(".otf")) {
            res.setHeader("Content-Type", "application/octet-stream");
          }
          createReadStream(file).pipe(res);
          return;
        }
        next();
      });
    },
    closeBundle() {
      for (const [from, prefix] of PDFJS_ASSETS) {
        const src = resolve(from);
        if (!existsSync(src)) continue;
        cpSync(src, resolve("dist", prefix), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  // GitHub Pages serves the build from /redaction-audit/ (set via VITE_BASE in build:pages).
  base: process.env.VITE_BASE ?? "/",
  plugins: [react(), pdfjsAssets()],
  build: { target: "es2022", chunkSizeWarningLimit: 2500 },
  test: { environment: "node", globals: true, include: ["src/**/*.test.ts"] },
});
