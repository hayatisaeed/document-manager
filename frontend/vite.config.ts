import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the API runs on Django (port 8000); Vite proxies /api to it.
const backend = process.env.DM_BACKEND_URL ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 2000 },
  server: {
    port: 5173,
    proxy: { "/api": { target: backend, changeOrigin: true } },
  },
});
