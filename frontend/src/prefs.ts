/**
 * Interface preferences: language (en/fa), theme and calendar.
 *
 * Saved on the server (so they survive browser changes) and mirrored to
 * localStorage so the first paint already has the right theme and direction
 * (see the inline script in index.html).
 */
import { useSyncExternalStore } from "react";

export type Lang = "en" | "fa";
export type Theme = "system" | "light" | "dark";
export type Calendar = "auto" | "gregorian" | "jalali";

export interface Prefs {
  lang: Lang;
  theme: Theme;
  calendar: Calendar;
}

const KEY = "dm:prefs";

function load(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { lang: raw.lang === "fa" ? "fa" : "en", theme: raw.theme ?? "system", calendar: raw.calendar ?? "auto" };
  } catch {
    return { lang: "en", theme: "system", calendar: "auto" };
  }
}

let prefs: Prefs = load();
const listeners = new Set<() => void>();

const darkQuery = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

export function resolvedTheme(p: Prefs = prefs): "light" | "dark" {
  if (p.theme === "light" || p.theme === "dark") return p.theme;
  return darkQuery?.matches ? "dark" : "light";
}

function apply() {
  const root = document.documentElement;
  root.lang = prefs.lang === "fa" ? "fa" : "en";
  root.dir = prefs.lang === "fa" ? "rtl" : "ltr";
  root.dataset.theme = resolvedTheme();
}

export function getPrefs(): Prefs {
  return prefs;
}

export function setPrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable */
  }
  apply();
  listeners.forEach((l) => l());
}

darkQuery?.addEventListener("change", () => {
  apply();
  listeners.forEach((l) => l());
});
apply();

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Re-render on preference changes (and on OS theme changes when theme = system). */
export function usePrefs(): Prefs & { dark: boolean } {
  const p = useSyncExternalStore(subscribe, () => prefs);
  const dark = useSyncExternalStore(subscribe, () => resolvedTheme() === "dark");
  return { ...p, dark };
}

// ------------------------------------------------------------------ formatting

export function locale(): string {
  return prefs.lang === "fa" ? "fa-IR" : "en-US";
}

function useJalali(): boolean {
  return prefs.calendar === "jalali" || (prefs.calendar === "auto" && prefs.lang === "fa");
}

function dateLocale(): string {
  return useJalali() ? `${locale()}-u-ca-persian` : `${locale()}-u-ca-gregory`;
}

export function fmtNum(n: number): string {
  return new Intl.NumberFormat(locale()).format(n);
}

export function fmtDate(iso: string, withTime = true): string {
  const opts: Intl.DateTimeFormatOptions = withTime
    ? { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "long", day: "numeric" };
  return new Intl.DateTimeFormat(dateLocale(), opts).format(new Date(iso));
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(seconds / 86400), "day");
  return fmtDate(iso, false);
}
