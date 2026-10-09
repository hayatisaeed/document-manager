import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { savePrefs } from "../components/PrefsToggles";
import { toast, toastError } from "../components/Toast";
import { t } from "../i18n";
import { fmtDate, usePrefs, type Prefs } from "../prefs";
import type { AppSettings, Credential } from "../types";

export default function SettingsPage() {
  const prefs = usePrefs();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [creds, setCreds] = useState<Credential[]>([]);
  const [host, setHost] = useState("github.com");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");

  useEffect(() => {
    api.get<AppSettings>("/api/settings/").then(setSettings).catch(toastError);
    api.get<Credential[]>("/api/credentials/").then(setCreds).catch(toastError);
  }, []);

  const saveIdentity = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setSettings(await api.put<AppSettings>("/api/settings/", { author_name: settings?.author_name, author_email: settings?.author_email }));
      toast(t("Saved"), "success");
    } catch (err) {
      toastError(err);
    }
  };

  const addCred = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/api/credentials/", { host, username, token });
      setCreds(await api.get<Credential[]>("/api/credentials/"));
      setToken("");
      toast(t("Credential saved"), "success");
    } catch (err) {
      toastError(err);
    }
  };

  const removeCred = async (id: number) => {
    await api.del(`/api/credentials/${id}/`).catch(toastError);
    setCreds((c) => c.filter((x) => x.id !== id));
  };

  if (!settings) return <div className="page muted">{t("Loading…")}</div>;
  const caps = settings.capabilities;
  const ok = (v: boolean) => (v ? `✓ ${t("installed")}` : `✗ ${t("missing")}`);

  return (
    <div className="page narrow">
      <p>
        <Link to="/">{t("← Projects")}</Link>
      </p>
      <h1>{t("Settings")}</h1>

      <section className="section">
        <h2>{t("Appearance and language")}</h2>
        <div className="form grid3">
          <label>
            {t("Language")}
            <select value={prefs.lang} onChange={(e) => savePrefs({ lang: e.target.value as Prefs["lang"] })}>
              <option value="en">English</option>
              <option value="fa">فارسی</option>
            </select>
          </label>
          <label>
            {t("Theme")}
            <select value={prefs.theme} onChange={(e) => savePrefs({ theme: e.target.value as Prefs["theme"] })}>
              <option value="system">{t("Same as system")}</option>
              <option value="light">{t("Light")}</option>
              <option value="dark">{t("Dark")}</option>
            </select>
          </label>
          <label>
            {t("Calendar")}
            <select value={prefs.calendar} onChange={(e) => savePrefs({ calendar: e.target.value as Prefs["calendar"] })}>
              <option value="auto">{t("Automatic (Jalali in Persian)")}</option>
              <option value="gregorian">{t("Gregorian")}</option>
              <option value="jalali">{t("Jalali (Shamsi)")}</option>
            </select>
            <small className="muted">
              {t("Today")}: {fmtDate(new Date().toISOString(), false)}
            </small>
          </label>
        </div>
      </section>

      <section className="section">
        <h2>{t("Your identity")}</h2>
        <p className="muted">{t("This name and email are recorded on every commit, so collaborators can see who changed what.")}</p>
        <form className="form" onSubmit={saveIdentity}>
          <label>
            {t("Name")}
            <input dir="auto" value={settings.author_name} onChange={(e) => setSettings({ ...settings, author_name: e.target.value })} />
          </label>
          <label>
            {t("Email")}
            <input type="email" dir="ltr" value={settings.author_email} onChange={(e) => setSettings({ ...settings, author_email: e.target.value })} />
          </label>
          <div className="row end">
            <button className="btn btn-primary">{t("Save")}</button>
          </div>
        </form>
      </section>

      <section className="section">
        <h2>{t("Git hosting credentials")}</h2>
        <p className="muted">
          {t(
            "Personal access tokens are used for HTTPS push, pull and clone. On GitHub, create a fine-grained token with “Contents: Read and write” for your repositories. On GitLab, create a token with write_repository. Tokens are stored in the local database and sent only to the matching host.",
          )}
        </p>
        {creds.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>{t("Host")}</th>
                <th>{t("Username")}</th>
                <th>{t("Token")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {creds.map((c) => (
                <tr key={c.id}>
                  <td dir="ltr">{c.host}</td>
                  <td dir="ltr">{c.username}</td>
                  <td className="mono">{c.token_preview}</td>
                  <td className="actions">
                    <button className="btn btn-sm btn-danger" onClick={() => removeCred(c.id)}>
                      {t("Remove")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form className="form grid3" onSubmit={addCred}>
          <label>
            {t("Host")}
            <input required dir="ltr" value={host} onChange={(e) => setHost(e.target.value)} placeholder="github.com" />
          </label>
          <label>
            {t("Username")}
            <input required dir="ltr" value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label>
            {t("Token")}
            <input required dir="ltr" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <div className="row end span3">
            <button className="btn btn-primary">{t("Save credential")}</button>
          </div>
        </form>
      </section>

      <section className="section">
        <h2>{t("System")}</h2>
        <ul className="plain-list">
          <li>Git: {ok(caps.git)}</li>
          <li>
            {t("Pandoc (preview and export)")}: {ok(caps.pandoc)} {caps.pandoc_version && <span dir="ltr">({caps.pandoc_version})</span>}
            {caps.pandoc_outdated && <div className="error-text small">{t("This Pandoc is older than 3.6 and cannot make Persian PDFs. Run the installer again to get a newer private copy.")}</div>}
          </li>
          <li>
            {t("PDF engines")}: {caps.pdf_engines.length ? <span dir="ltr">{caps.pdf_engines.join(", ")}</span> : t("none (PDF export unavailable)")}
          </li>
          <li>
            {t("Jupyter (run notebook cells)")}: {ok(caps.jupyter)}
          </li>
          <li>
            {t("Projects directory")}:{" "}
            <span className="mono" dir="ltr">
              {settings.projects_dir}
            </span>
          </li>
        </ul>
      </section>
    </div>
  );
}
