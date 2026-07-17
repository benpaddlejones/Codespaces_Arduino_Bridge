import { defineConfig } from "vite";
import { readFileSync } from "fs";

// Single source of truth for the app version: the extension's package.json.
// Injected into the client bundle (as __APP_VERSION__) so CLIENT_VERSION always
// equals the build version — and therefore matches the server, which reads the
// same file. A version mismatch then reliably means a stale cached client.
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export default defineConfig({
  root: ".",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 3000,
    strictPort: true,
    open: true,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/artifacts": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: "index.html",
        test: "tests/protocol-test.html",
      },
    },
  },
});
