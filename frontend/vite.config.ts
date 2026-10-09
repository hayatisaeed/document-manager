import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * @jupyter-widgets packages read their version with CommonJS
 * `require("../package.json")` inside ES modules; turn that into a JSON import.
 */
function jupyterWidgetsRequire(): Plugin {
  const pattern = /require\((["'])\.\.\/package\.json\1\)\.version/g;
  return {
    name: "jupyter-widgets-package-version",
    transform(code, id) {
      if (!id.includes("@jupyter-widgets/") || !pattern.test(code)) return null;
      pattern.lastIndex = 0;
      return `import __widgetsPackage from "../package.json";\n${code.replace(pattern, "__widgetsPackage.version")}`;
    },
  };
}

// In development the API runs on Django (port 8000); Vite proxies /api to it.
const backend = process.env.DM_BACKEND_URL ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react(), jupyterWidgetsRequire()],
  build: { chunkSizeWarningLimit: 4000 },
  server: {
    port: 5173,
    proxy: { "/api": { target: backend, changeOrigin: true } },
  },
});
