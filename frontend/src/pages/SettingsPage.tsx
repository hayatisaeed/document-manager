import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { toast, toastError } from "../components/Toast";
import type { AppSettings, Credential } from "../types";

export default function SettingsPage() {
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
      setSettings(await api.put<AppSettings>("/api/settings/", settings));
      toast("Saved", "success");
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
      toast("Credential saved", "success");
    } catch (err) {
      toastError(err);
    }
  };

  const removeCred = async (id: number) => {
    await api.del(`/api/credentials/${id}/`).catch(toastError);
    setCreds((c) => c.filter((x) => x.id !== id));
  };

  if (!settings) return <div className="page muted">Loading…</div>;
  const caps = settings.capabilities;

  return (
    <div className="page narrow">
      <p>
        <Link to="/">← Projects</Link>
      </p>
      <h1>Settings</h1>

      <section className="section">
        <h2>Your identity</h2>
        <p className="muted">This name and email are recorded on every commit, so collaborators can see who changed what.</p>
        <form className="form" onSubmit={saveIdentity}>
          <label>
            Name
            <input value={settings.author_name} onChange={(e) => setSettings({ ...settings, author_name: e.target.value })} />
          </label>
          <label>
            Email
            <input type="email" value={settings.author_email} onChange={(e) => setSettings({ ...settings, author_email: e.target.value })} />
          </label>
          <div className="row end">
            <button className="btn btn-primary">Save</button>
          </div>
        </form>
      </section>

      <section className="section">
        <h2>Git hosting credentials</h2>
        <p className="muted">
          Personal access tokens are used for HTTPS push, pull and clone. On GitHub, create a fine-grained token with
          “Contents: Read and write” for your repositories. On GitLab, create a token with <code>write_repository</code>.
          Tokens are stored in the local database and sent only to the matching host.
        </p>
        {creds.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Host</th>
                <th>Username</th>
                <th>Token</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {creds.map((c) => (
                <tr key={c.id}>
                  <td>{c.host}</td>
                  <td>{c.username}</td>
                  <td className="mono">{c.token_preview}</td>
                  <td>
                    <button className="btn btn-sm btn-danger" onClick={() => removeCred(c.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form className="form grid3" onSubmit={addCred}>
          <label>
            Host
            <input required value={host} onChange={(e) => setHost(e.target.value)} placeholder="github.com" />
          </label>
          <label>
            Username
            <input required value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label>
            Token
            <input required type="password" value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <div className="row end span3">
            <button className="btn btn-primary">Save credential</button>
          </div>
        </form>
      </section>

      <section className="section">
        <h2>System</h2>
        <ul className="plain-list">
          <li>Git: {caps.git ? "✓ installed" : "✗ missing"}</li>
          <li>Pandoc (preview and export): {caps.pandoc ? "✓ installed" : "✗ missing"}</li>
          <li>PDF engines: {caps.pdf_engines.length ? caps.pdf_engines.join(", ") : "none (PDF export unavailable)"}</li>
          <li>
            Projects directory: <span className="mono">{settings.projects_dir}</span>
          </li>
        </ul>
      </section>
    </div>
  );
}
