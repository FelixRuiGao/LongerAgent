import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  root: resolve(__dirname, "renderer"),
  plugins: [react()],
  base: "./",
  build: {
    outDir: resolve(__dirname, "dist-main", "dist-renderer"),
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    // Electron loads via file://, crossorigin attributes cause issues
    crossOriginLoading: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
