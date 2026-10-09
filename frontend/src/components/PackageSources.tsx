import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { toast, toastError } from "./Toast";
import { t } from "../i18n";
import type { PackageConfig, PackageSources as Sources, SourcePreset } from "../types";

type TestResult = { ok: boolean; ms: number | null; error: string | null } | "testing";

const REGION_LABEL: Record<SourcePreset["region"], string> = { official: "Official", iran: "Iran", china: "China" };
// i18n: Official|Iran|China

const lines = (v: string) => v.split(/[\s,]+/).filter(Boolean);

/** Settings → package sources: PyPI index and conda channel mirrors, and a proxy. */
export default function PackageSources() {
  const [data, setData] = useState<Sources | null>(null);
  const [config, setConfig] = useState<PackageConfig | null>(null);
  const [condaPath, setCondaPath] = useState("");
  const [pipMode, setPipMode] = useState<"default" | "preset" | "custom">("default");
  const [condaMode, setCondaMode] = useState<"default" | "preset" | "custom">("default");
  const [extra, setExtra] = useState("");
  const [trusted, setTrusted] = useState("");
  const [channels, setChannels] = useState("");
  const [results, setResults] = useState<Record<string, TestResult>>({});

  useEffect(() => {
    api
      .get<Sources>("/api/package-sources/")
      .then((d) => {
        setData(d);
        setConfig(d.config);
        setCondaPath(d.conda_path);
        const c = d.config;
        setPipMode(!c.pip_index_url ? "default" : d.presets.pip.some((p) => p.url === c.pip_index_url) ? "preset" : "custom");
        const one = c.conda_channels.length === 1 ? c.conda_channels[0] : null;
        setCondaMode(!c.conda_channels.length ? "default" : one && d.presets.conda.some((p) => p.url === one) ? "preset" : "custom");
        setExtra(c.pip_extra_index_urls.join("\n"));
        setTrusted(c.pip_trusted_hosts.join(" "));
        setChannels(c.conda_channels.join("\n"));
      })
      .catch(toastError);
  }, []);

  if (!data || !config) return <p className="muted">{t("Loading…")}</p>;
  const set = (patch: Partial<PackageConfig>) => setConfig({ ...config, ...patch });

  const test = async (kind: "pip" | "conda", url: string) => {
    const key = `${kind} ${url}`;
    setResults((r) => ({ ...r, [key]: "testing" }));
    try {
      const r = await api.post<{ ok: boolean; ms: number | null; error: string | null }>("/api/package-sources/test/", { kind, url });
      setResults((rs) => ({ ...rs, [key]: r }));
    } catch (e) {
      setResults((rs) => ({ ...rs, [key]: { ok: false, ms: null, error: e instanceof Error ? e.message : String(e) } }));
    }
  };
  const testAll = (kind: "pip" | "conda") => (kind === "pip" ? data.presets.pip : data.presets.conda).forEach((p) => test(kind, p.url));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const payload: PackageConfig = {
      ...config,
      pip_index_url: pipMode === "default" ? "" : config.pip_index_url,
      pip_extra_index_urls: lines(extra),
      pip_trusted_hosts: lines(trusted),
      conda_channels: condaMode === "default" ? [] : condaMode === "custom" ? lines(channels) : config.conda_channels,
    };
    try {
      const d = await api.put<Sources>("/api/package-sources/", { config: payload, conda_path: condaPath });
      setConfig(d.config);
      setChannels(d.config.conda_channels.join("\n"));
      toast(t("Saved"), "success");
    } catch (err) {
      toastError(err);
    }
  };

  const result = (kind: "pip" | "conda", url: string) => {
    const r = results[`${kind} ${url}`];
    if (!r) return null;
    if (r === "testing") return <span className="source-result muted">{t("Testing…")}</span>;
    return r.ok ? (
      <span className="source-result ok">✓ {t("{ms} ms", { ms: r.ms ?? 0 })}</span>
    ) : (
      <span className="source-result error-text" title={r.error ?? ""}>
        ✗ {t("unreachable")}
      </span>
    );
  };

  const presetTable = (kind: "pip" | "conda", presets: SourcePreset[], current: string, pick: (url: string) => void, enabled: boolean) => (
    <table className="table preset-table">
      <tbody>
        {presets.map((p) => (
          <tr key={p.id} className={enabled && current === p.url ? "current" : ""}>
            <td>
              <label className="row tight">
                <input type="radio" name={`${kind}-preset`} checked={enabled && current === p.url} onChange={() => pick(p.url)} />
                <span dir="ltr">{p.name}</span>
              </label>
            </td>
            <td className="small muted">{t(REGION_LABEL[p.region])}</td>
            <td className="small mono muted" dir="ltr" style={{ wordBreak: "break-all" }}>
              {p.url}
            </td>
            <td className="actions">
              {result(kind, p.url)}{" "}
              <button type="button" className="btn btn-sm" onClick={() => test(kind, p.url)}>
                {t("Test")}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const pipPreset = pipMode === "preset";
  const condaPreset = condaMode === "preset";

  return (
    <form className="form" onSubmit={save}>
      <p className="muted">
        {t(
          "Where pip and conda download packages from, when the app installs them or creates an environment (also used by %pip inside notebooks). Your own pip.conf and .condarc are not changed. Mirrors run by third parties may stop working; use Test to check them.",
        )}
      </p>

      <h3>{t("Python packages (pip)")}</h3>
      <div className="row">
        {(["default", "preset", "custom"] as const).map((m) => (
          <label key={m} className={`choice ${pipMode === m ? "active" : ""}`}>
            <input
              type="radio"
              checked={pipMode === m}
              onChange={() => {
                setPipMode(m);
                if (m === "preset" && !data.presets.pip.some((p) => p.url === config.pip_index_url)) set({ pip_index_url: data.presets.pip[0].url });
              }}
            />{" "}
            {m === "default" ? t("pip's own settings") : m === "preset" ? t("A mirror from the list") : t("Custom address")}
          </label>
        ))}
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={() => testAll("pip")}>
          {t("Test all")}
        </button>
      </div>
      {pipMode === "custom" && (
        <label>
          {t("Index URL (simple API)")}
          <input dir="ltr" value={config.pip_index_url} onChange={(e) => set({ pip_index_url: e.target.value })} placeholder="https://mirror.example.com/pypi/simple" />
        </label>
      )}
      {presetTable("pip", data.presets.pip, config.pip_index_url, (url) => {
        setPipMode("preset");
        set({ pip_index_url: url });
      }, pipPreset)}
      <details>
        <summary>{t("More pip options")}</summary>
        <div className="form" style={{ marginTop: 8 }}>
          <label>
            {t("Extra index URLs (one per line)")}
            <textarea rows={2} dir="ltr" value={extra} onChange={(e) => setExtra(e.target.value)} />
            <small className="muted">{t("Searched in addition to the main index, for example a private package server.")}</small>
          </label>
          <label>
            {t("Trusted hosts")}
            <input dir="ltr" value={trusted} onChange={(e) => setTrusted(e.target.value)} placeholder="mirror.example.com" />
            <small className="muted">{t("Only for mirrors without a valid HTTPS certificate. Hosts of http:// mirrors are trusted automatically.")}</small>
          </label>
        </div>
      </details>

      <h3>{t("conda channels")}</h3>
      <div className="row">
        {(["default", "preset", "custom"] as const).map((m) => (
          <label key={m} className={`choice ${condaMode === m ? "active" : ""}`}>
            <input
              type="radio"
              checked={condaMode === m}
              onChange={() => {
                setCondaMode(m);
                if (m === "preset" && !(config.conda_channels.length === 1 && data.presets.conda.some((p) => p.url === config.conda_channels[0])))
                  set({ conda_channels: [data.presets.conda[0].url] });
              }}
            />{" "}
            {m === "default" ? t("conda's own settings") : m === "preset" ? t("A mirror from the list") : t("Custom channels")}
          </label>
        ))}
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={() => testAll("conda")}>
          {t("Test all")}
        </button>
      </div>
      {condaMode === "custom" && (
        <label>
          {t("Channels, in order (one per line)")}
          <textarea rows={3} dir="ltr" value={channels} onChange={(e) => setChannels(e.target.value)} placeholder={"https://mirror.example.com/conda-forge\nbioconda"} />
          <small className="muted">{t("Names such as conda-forge or full URLs. These replace the channels in .condarc for the app's commands.")}</small>
        </label>
      )}
      {presetTable("conda", data.presets.conda, config.conda_channels[0] ?? "", (url) => {
        setCondaMode("preset");
        set({ conda_channels: [url] });
      }, condaPreset)}
      <label className="row">
        <input type="checkbox" checked={config.use_mamba} onChange={(e) => set({ use_mamba: e.target.checked })} />
        {t("Use mamba for conda environments when it is installed (much faster)")}
      </label>
      <label>
        {t("Path to conda (only if it is not found automatically)")}
        <input dir="ltr" value={condaPath} onChange={(e) => setCondaPath(e.target.value)} placeholder={"C:\\Users\\me\\miniconda3  ·  /home/me/miniforge3"} />
      </label>

      <h3>{t("Proxy")}</h3>
      <div className="form grid3">
        <label>
          {t("HTTPS proxy")}
          <input dir="ltr" value={config.https_proxy} onChange={(e) => set({ https_proxy: e.target.value })} placeholder="http://127.0.0.1:8080" />
        </label>
        <label>
          {t("HTTP proxy")}
          <input dir="ltr" value={config.http_proxy} onChange={(e) => set({ http_proxy: e.target.value })} placeholder="http://127.0.0.1:8080" />
        </label>
        <label>
          {t("No proxy for")}
          <input dir="ltr" value={config.no_proxy} onChange={(e) => set({ no_proxy: e.target.value })} placeholder="localhost,127.0.0.1" />
        </label>
      </div>
      <small className="muted">{t("Used for package downloads and the speed tests. Leave empty to connect directly.")}</small>

      <div className="row end">
        <button className="btn btn-primary">{t("Save package sources")}</button>
      </div>
    </form>
  );
}
