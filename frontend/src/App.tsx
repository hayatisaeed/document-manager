import { useEffect } from "react";
import { Link, Route, Routes } from "react-router-dom";
import ProjectsPage from "./pages/ProjectsPage";
import SettingsPage from "./pages/SettingsPage";
import Workspace from "./pages/Workspace";
import { ToastHost } from "./components/Toast";
import { api } from "./api";
import { setPrefs, usePrefs, type Prefs } from "./prefs";
import { t } from "./i18n";
import type { AppSettings } from "./types";

export default function App() {
  const prefs = usePrefs();

  // The server holds the saved preferences; localStorage only speeds up the first paint.
  useEffect(() => {
    api
      .get<AppSettings>("/api/settings/")
      .then((s) => setPrefs({ lang: s.ui_language as Prefs["lang"], theme: s.theme as Prefs["theme"], calendar: s.calendar as Prefs["calendar"] }))
      .catch(() => {});
  }, []);

  return (
    // Keyed by language so every string is re-translated when it changes.
    <div key={prefs.lang} className="app-root">
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/p/:slug" element={<Workspace />} />
        <Route
          path="*"
          element={
            <div className="page">
              <h1>{t("Not found")}</h1>
              <Link to="/">{t("Back to projects")}</Link>
            </div>
          }
        />
      </Routes>
      <ToastHost />
    </div>
  );
}
