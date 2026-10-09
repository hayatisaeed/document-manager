// Copies chart libraries used by sandboxed notebook outputs into public/vendor,
// so Plotly and Vega/Altair charts work offline. Runs before `dev` and `build`.
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const out = new URL("../public/vendor/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const files = {
  "plotly.min.js": "plotly.js-dist-min/plotly.min.js",
  "vega.min.js": "vega/build/vega.min.js",
  "vega-lite.min.js": "vega-lite/build/vega-lite.min.js",
  "vega-embed.min.js": "vega-embed/build/vega-embed.min.js",
};
for (const [name, spec] of Object.entries(files)) {
  copyFileSync(new URL(`../node_modules/${spec}`, import.meta.url).pathname, join(out, name));
}
console.log(`Copied ${Object.keys(files).length} vendor scripts to public/vendor/`);
