import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

/**
 * Serve pdf.js's own resources (standard-14 font data, character maps, ICC
 * colour profiles, wasm image decoders) from our own origin at /pdfjs/<dir>/,
 * and copy them into the bundle. The app's CSP allows no CDN, and a phone may
 * be offline. See src/lib/pdf.ts. (Tally does the same for its fonts.)
 */
function pdfjsResources(): Plugin {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  const dirs = ["standard_fonts", "cmaps", "iccs", "wasm"];
  const base = "/pdfjs/";
  return {
    name: "commonplace-pdfjs-resources",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0] ?? "";
        if (!url.startsWith(base)) return next();
        const [dir = "", ...rest] = decodeURIComponent(url.slice(base.length)).split("/");
        const from = join(root, dir);
        // Only ever a file in one of those directories, whatever the request says.
        const file = resolve(from, rest.join("/"));
        if (!dirs.includes(dir) || !file.startsWith(from + sep)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        void readFile(file).then(
          (buf) => {
            res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
            res.end(buf);
          },
          () => {
            // Not falling through: the SPA fallback would answer with index.html.
            res.statusCode = 404;
            res.end();
          },
        );
      });
    },
    async generateBundle() {
      for (const dir of dirs) {
        for (const name of await readdir(join(root, dir))) {
          this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${name}`, source: await readFile(join(root, dir, name)) });
        }
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), pdfjsResources()],

  build: {
    // pdf.js and the editor are the large chunks; both load lazily with the
    // screens that need them.
    chunkSizeWarningLimit: 1600,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // Left out rather than `undefined` when there's no dev host
    // (exactOptionalPropertyTypes, tsconfig.node.json).
    ...(host ? { hmr: { protocol: "ws", host, port: 1421 } } : {}),
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
