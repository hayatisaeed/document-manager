// Lists UI strings passed to t("…") that have no Persian translation.
// Usage: node scripts/check-i18n.mjs   (exit code 1 when something is missing)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|ts)$/.test(name)) files.push(p);
  }
})(SRC);

const keys = new Set();
const re = /\bt\(\s*("(?:[^"\\]|\\.)*")/g;
// Strings looked up indirectly, e.g. t(KIND_LABEL[kind]) or t(status).
const indirect = /\/\/ i18n: (.+)$/gm;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(re)) keys.add(JSON.parse(m[1]));
  for (const m of src.matchAll(indirect)) for (const k of m[1].split("|")) keys.add(k.trim());
}

const faSrc = readFileSync(join(SRC, "locales/fa.ts"), "utf8");
const have = new Set(
  [...faSrc.matchAll(/^\s*(?:("(?:[^"\\]|\\.)*")|([A-Za-z_$][\w$]*))\s*:/gm)].map((m) => (m[1] ? JSON.parse(m[1]) : m[2])),
);
const missing = [...keys].filter((k) => !have.has(k)).sort();
const unused = [...have].filter((k) => !keys.has(k)).sort();
if (unused.length) console.log(`Unused translations (${unused.length}):\n` + unused.map((k) => "  " + JSON.stringify(k)).join("\n"));
if (missing.length) {
  console.log(`Missing Persian translations (${missing.length}):`);
  for (const k of missing) console.log("  " + JSON.stringify(k));
  process.exit(1);
}
console.log(`All ${keys.size} UI strings are translated.`);
