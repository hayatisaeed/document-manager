import { getPrefs } from "./prefs";
import { fa } from "./locales/fa";

/**
 * Translate an English UI string. Keys are the English text itself, so
 * untranslated strings fall back to readable English. `{name}` placeholders
 * are filled from `vars`.
 */
export function t(text: string, vars?: Record<string, string | number>): string {
  let out = getPrefs().lang === "fa" ? (fa[text] ?? text) : text;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      const value = typeof v === "number" ? new Intl.NumberFormat(getPrefs().lang === "fa" ? "fa-IR" : "en-US").format(v) : v;
      out = out.split(`{${k}}`).join(value);
    }
  }
  return out;
}
