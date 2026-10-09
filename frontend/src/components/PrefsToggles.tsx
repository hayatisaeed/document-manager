import { api } from "../api";
import { t } from "../i18n";
import { getPrefs, setPrefs, usePrefs, type Prefs } from "../prefs";

/** Save preferences locally right away and on the server in the background. */
export function savePrefs(patch: Partial<Prefs>) {
  setPrefs(patch);
  const p = getPrefs();
  api.put("/api/settings/", { ui_language: p.lang, theme: p.theme, calendar: p.calendar }).catch(() => {});
}

const NEXT_THEME: Record<Prefs["theme"], Prefs["theme"]> = { system: "light", light: "dark", dark: "system" };
const THEME_ICON: Record<Prefs["theme"], string> = { system: "◐", light: "☀", dark: "☾" };
const THEME_LABEL: Record<Prefs["theme"], string> = { system: "System theme", light: "Light theme", dark: "Dark theme" };
// i18n: System theme|Light theme|Dark theme

/** Compact theme + language switches for headers. */
export default function PrefsToggles() {
  const { theme, lang } = usePrefs();
  return (
    <span className="prefs-toggles">
      <button
        className="icon-toggle"
        onClick={() => savePrefs({ theme: NEXT_THEME[theme] })}
        title={`${t(THEME_LABEL[theme])} — ${t("click to change")}`}
        aria-label={t(THEME_LABEL[theme])}
      >
        {THEME_ICON[theme]}
      </button>
      <button
        className="icon-toggle lang-toggle"
        onClick={() => savePrefs({ lang: lang === "fa" ? "en" : "fa" })}
        title={lang === "fa" ? "English" : "فارسی"}
      >
        {lang === "fa" ? "EN" : "فا"}
      </button>
    </span>
  );
}
