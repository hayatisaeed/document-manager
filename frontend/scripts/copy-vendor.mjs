// Copies chart libraries used by sandboxed notebook outputs into public/vendor,
// so Plotly and Vega/Altair charts work offline, and Excalidraw's fonts so drawings
// look right without the internet. Runs before `dev` and `build`.
import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const out = fileURLToPath(new URL("../public/vendor/", import.meta.url));
mkdirSync(out, { recursive: true });
const files = {
  "plotly.min.js": "plotly.js-dist-min/plotly.min.js",
  "vega.min.js": "vega/build/vega.min.js",
  "vega-lite.min.js": "vega-lite/build/vega-lite.min.js",
  "vega-embed.min.js": "vega-embed/build/vega-embed.min.js",
};
for (const [name, spec] of Object.entries(files)) {
  copyFileSync(fileURLToPath(new URL(`../node_modules/${spec}`, import.meta.url)), join(out, name));
}
console.log(`Copied ${Object.keys(files).length} vendor scripts to public/vendor/`);

// Served at /excalidraw/fonts/… (window.EXCALIDRAW_ASSET_PATH is "/excalidraw/").
const fonts = fileURLToPath(new URL("../node_modules/@excalidraw/excalidraw/dist/prod/fonts", import.meta.url));
cpSync(fonts, fileURLToPath(new URL("../public/excalidraw/fonts", import.meta.url)), { recursive: true });
console.log("Copied Excalidraw fonts to public/excalidraw/fonts/");
