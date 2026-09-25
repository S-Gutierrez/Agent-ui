import { defineConfig } from "vitest/config";

const apiPort = Number(process.env.OFFICE_PORT ?? 4317);

export default defineConfig({
  root: ".",
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
  build: { outDir: "dist", emptyOutDir: true },
  test: { include: ["test/**/*.test.ts"] },
});
