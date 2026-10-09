import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, qs } from "../api";
import JobLog from "../components/JobLog";
import Modal from "../components/Modal";
import { toast, toastError } from "../components/Toast";
import { t } from "../i18n";
import type { EnvList, Job, PyEnv, PyPackage } from "../types";

const KIND_LABEL: Record<string, string> = { conda: "conda", venv: "venv" };

export function envLabel(e: Pick<PyEnv, "name" | "kind" | "python_version">): string {
  return `${e.name} · ${KIND_LABEL[e.kind] ?? e.kind}${e.python_version ? ` · Python ${e.python_version}` : ""}`;
}

export default function EnvironmentsPage() {
  const [data, setData] = useState<EnvList | null>(null);
  const [params, setParams] = useSearchParams();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [modal, setModal] = useState<"new" | "add" | null>(null);
  const [revision, setRevision] = useState(0);
  const selectedId = params.get("env");

  const load = useCallback(async (refresh = false) => {
    try {
      setData(await api.get<EnvList>("/api/envs/" + qs({ refresh: refresh ? 1 : undefined })));
    } catch (e) {
      toastError(e);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const select = (id: string) => setParams({ env: id }, { replace: true });
  const selected = data?.envs.find((e) => e.id === selectedId) ?? data?.envs[0] ?? null;
  const addJob = (job: Job) => setJobs((js) => [job, ...js.filter((j) => j.id !== job.id)]);
  const jobDone = (job: Job) => {
    if (job.state === "succeeded") toast(t("Finished: {task}", { task: job.title }), "success");
    setRevision((r) => r + 1);
    load(true);
  };

  const groups: [string, PyEnv[]][] = data
    ? [
        [t("This app"), data.envs.filter((e) => e.is_app)],
        ["conda", data.envs.filter((e) => !e.is_app && e.kind === "conda")],
        [t("Virtual environments (venv)"), data.envs.filter((e) => !e.is_app && e.kind === "venv")],
      ]
    : [];

  return (
    <div className="page">
      <p>
        <Link to="/">{t("← Projects")}</Link>
      </p>
      <header className="page-head">
        <div>
          <h1>{t("Python environments")}</h1>
          <p className="muted">
            {t("Notebooks run in one of these environments. Choose one per project or per notebook, and install the packages your code needs.")}
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => load(true)}>
            ↻ {t("Refresh")}
          </button>
          <button className="btn" onClick={() => setModal("add")}>
            {t("Add existing…")}
          </button>
          <button className="btn btn-primary" onClick={() => setModal("new")}>
            {t("New environment")}
          </button>
        </div>
      </header>

      {data && (
        <p className="small muted">
          {data.conda ? (
            <>
              {t("conda {version} found", { version: data.conda.version })}
              {data.conda.mamba && ` · ${t("mamba available (faster installs)")}`} ·{" "}
              <span className="mono" dir="ltr">
                {data.conda.exe}
              </span>
            </>
          ) : (
            <>
              {t("conda was not found, so only virtual environments are available.")}{" "}
              <Link to="/settings#package-sources">{t("Set the path to conda in Settings")}</Link>
            </>
          )}
        </p>
      )}

      {jobs.map((j) => (
        <JobLog key={j.id} job={j} onDone={jobDone} compact />
      ))}

      {!data ? (
        <p className="muted">{t("Loading…")}</p>
      ) : (
        <div className="env-layout">
          <nav className="env-list" aria-label={t("Python environments")}>
            {groups.map(([label, list]) =>
              list.length ? (
                <div key={label}>
                  <div className="env-group">{label}</div>
                  {list.map((e) => (
                    <button key={e.id} className={`env-item ${selected?.id === e.id ? "active" : ""}`} onClick={() => select(e.id)}>
                      <strong dir="auto">{e.name}</strong>
                      <small>
                        {e.python_version ? `Python ${e.python_version}` : t("Python version unknown")}
                        {!e.has_ipykernel && ` · ${t("no ipykernel")}`}
                        {e.in_use && ` · ${t("in use")}`}
                      </small>
                    </button>
                  ))}
                </div>
              ) : null,
            )}
          </nav>
          {selected && <EnvDetail key={selected.id} env={selected} conda={!!data.conda} revision={revision} onJob={addJob} onChanged={() => load(true)} />}
        </div>
      )}

      {modal === "new" && (
        <NewEnvModal
          data={data}
          onClose={() => setModal(null)}
          onJob={(j) => {
            addJob(j);
            setModal(null);
          }}
        />
      )}
      {modal === "add" && (
        <AddEnvModal
          onClose={() => setModal(null)}
          onAdded={(e) => {
            setModal(null);
            load(true).then(() => select(e.id));
          }}
        />
      )}
    </div>
  );
}

function EnvDetail({
  env,
  conda,
  revision,
  onJob,
  onChanged,
}: {
  env: PyEnv;
  conda: boolean;
  revision: number;
  onJob: (j: Job) => void;
  onChanged: () => void;
}) {
  const [packages, setPackages] = useState<PyPackage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [topOnly, setTopOnly] = useState(false);
  const [specs, setSpecs] = useState("");
  const canConda = env.kind === "conda" && conda;
  const [manager, setManager] = useState<"pip" | "conda">(canConda ? "conda" : "pip");
  const [lookup, setLookup] = useState<{ name: string; versions: string[]; channel?: string }[] | null>(null);
  const [looking, setLooking] = useState(false);

  const loadPackages = useCallback(() => {
    setLoadError(null);
    api
      .get<{ packages: PyPackage[] }>(`/api/envs/${env.id}/packages/`)
      .then((r) => setPackages(r.packages))
      .catch((e) => setLoadError(e.message));
  }, [env.id]);
  // Reload after every finished task (installs, upgrades, removals).
  useEffect(loadPackages, [loadPackages, revision]);

  const run = async (action: "install" | "upgrade" | "uninstall", list: string[], mgr: "pip" | "conda" = manager) => {
    try {
      onJob(await api.post<Job>(`/api/envs/${env.id}/packages/`, { action, packages: list, manager: mgr }));
    } catch (e) {
      toastError(e);
    }
  };

  const install = (e: FormEvent) => {
    e.preventDefault();
    const list = specs.split(/\s+/).filter(Boolean);
    if (!list.length) return;
    run("install", list).then(() => setSpecs(""));
  };

  const doLookup = async () => {
    const name = specs.trim().split(/\s+/)[0]?.replace(/[=<>!~].*$/, "");
    if (!name) return;
    setLooking(true);
    try {
      const r = await api.get<{ results: { name: string; versions: string[]; channel?: string }[] }>(
        "/api/packages/lookup/" + qs({ name, manager }),
      );
      setLookup(r.results);
    } catch (e) {
      toastError(e);
    } finally {
      setLooking(false);
    }
  };

  const remove = async () => {
    const external = !env.created_by_app && env.kind === "venv";
    let deleteFiles = true;
    if (external) {
      deleteFiles = confirm(t("Also delete the environment's files from disk?\n\nOK = delete the folder too\nCancel = only remove it from this list"));
      if (!deleteFiles && !confirm(t("Remove {name} from the list? Its files stay where they are.", { name: env.name }))) return;
    }
    if (deleteFiles && !confirm(t("Permanently delete the environment {name} and everything installed in it?", { name: env.name }))) return;
    try {
      const job = await api.del<Job | undefined>(`/api/envs/${env.id}/` + qs({ delete_files: deleteFiles ? "true" : undefined }));
      if (job) onJob(job);
      else onChanged();
    } catch (e) {
      toastError(e);
    }
  };

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (packages ?? []).filter((p) => (!topOnly || p.top_level) && (!f || p.name.toLowerCase().includes(f)));
  }, [packages, filter, topOnly]);

  const canDelete = !env.is_app && !env.is_conda_base;

  return (
    <div className="env-detail">
      <section className="section">
        <div className="row between">
          <h2 dir="auto">{env.name}</h2>
          {canDelete && (
            <button className="btn btn-sm btn-danger" onClick={remove} disabled={env.in_use}>
              {env.kind === "venv" && !env.created_by_app ? t("Remove…") : t("Delete…")}
            </button>
          )}
        </div>
        <div className="row tight">
          <span className="badge">{env.kind === "conda" ? t("conda environment") : t("virtual environment")}</span>
          {env.python_version && <span className="badge">Python {env.python_version}</span>}
          {env.is_app && <span className="badge">{t("Used by the app itself")}</span>}
          {env.is_conda_base && <span className="badge">{t("conda base")}</span>}
        </div>
        <p className="env-path" dir="ltr">
          {env.path}
        </p>
        {env.in_use && <p className="small muted">{t("A notebook kernel is running in this environment.")}</p>}
        {!env.has_ipykernel && (
          <div className="banner banner-warn">
            <span>{t("Notebooks need the ipykernel package, which this environment does not have.")}</span>
            <button className="btn btn-sm btn-primary" onClick={() => run("install", ["ipykernel"], canConda ? "conda" : "pip")}>
              {t("Install ipykernel")}
            </button>
          </div>
        )}
        {env.is_app && (
          <p className="small muted">
            {t("Packages installed here are shared with the app itself. Keep notebook packages in a separate environment if you want to be safe from conflicts.")}
          </p>
        )}
      </section>

      <section className="section">
        <h2>{t("Install packages")}</h2>
        <form className="form" onSubmit={install}>
          <div className="row">
            <input
              className="grow"
              style={{ flex: 1, minWidth: 220 }}
              dir="ltr"
              value={specs}
              onChange={(e) => {
                setSpecs(e.target.value);
                setLookup(null);
              }}
              placeholder={manager === "conda" ? "numpy pandas=2.2" : "numpy pandas==2.2"}
              aria-label={t("Packages")}
            />
            {canConda && (
              <select value={manager} onChange={(e) => setManager(e.target.value as "pip" | "conda")} aria-label={t("Install with")}>
                <option value="conda">{t("with conda")}</option>
                <option value="pip">{t("with pip")}</option>
              </select>
            )}
            <button type="button" className="btn" onClick={doLookup} disabled={looking || !specs.trim()}>
              {looking ? t("Looking up…") : t("Look up")}
            </button>
            <button className="btn btn-primary" disabled={!specs.trim()}>
              {t("Install")}
            </button>
          </div>
          <small className="muted">
            {manager === "conda"
              ? t("Separate several packages with spaces. Pin a version with =, for example pandas=2.2.")
              : t("Separate several packages with spaces. Pin a version with ==, for example pandas==2.2.")}{" "}
            <Link to="/settings#package-sources">{t("Package sources and mirrors")}</Link>
          </small>
        </form>
        {lookup && (
          <div className="small">
            {lookup.length === 0 ? (
              <p className="muted">{t("No package with that name was found.")}</p>
            ) : (
              lookup.slice(0, 8).map((r) => (
                <p key={r.name}>
                  <strong dir="ltr">{r.name}</strong>
                  {r.channel && (
                    <span className="muted" dir="ltr">
                      {" "}
                      ({r.channel})
                    </span>
                  )}
                  :{" "}
                  {r.versions.slice(0, 12).map((v) => (
                    <button key={v} type="button" className="choice" dir="ltr" onClick={() => setSpecs(`${r.name}${manager === "conda" ? "=" : "=="}${v}`)}>
                      {v}
                    </button>
                  ))}
                </p>
              ))
            )}
          </div>
        )}
      </section>

      <section className="section">
        <div className="row between">
          <h2>{t("Installed packages")}</h2>
          <div className="row">
            <label className="row small">
              <input type="checkbox" checked={topOnly} onChange={(e) => setTopOnly(e.target.checked)} />
              {t("Only packages nothing else depends on")}
            </label>
            <input className="pkg-filter" dir="ltr" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("Filter…")} aria-label={t("Filter…")} />
          </div>
        </div>
        {loadError ? (
          <p className="error-text">{loadError}</p>
        ) : packages === null ? (
          <p className="muted">{t("Loading…")}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("Package")}</th>
                <th>{t("Version")}</th>
                <th>{t("Installed by")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.name}>
                  <td dir="ltr">{p.name}</td>
                  <td className="pkg-version" dir="ltr">
                    {p.version}
                  </td>
                  <td className="small muted" dir="ltr">
                    {p.manager}
                    {p.channel && p.manager === "conda" ? ` (${p.channel.replace(/^https?:\/\/[^/]+\//, "")})` : ""}
                  </td>
                  <td className="actions">
                    <button className="btn btn-sm" onClick={() => run("upgrade", [p.name], p.manager === "conda" && canConda ? "conda" : "pip")}>
                      {t("Upgrade")}
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => confirm(t("Remove {name}?", { name: p.name })) && run("uninstall", [p.name], p.manager === "conda" && canConda ? "conda" : "pip")}
                    >
                      {t("Remove")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function NewEnvModal({ data, onClose, onJob }: { data: EnvList | null; onClose: () => void; onJob: (j: Job) => void }) {
  const hasConda = !!data?.conda;
  const [kind, setKind] = useState<"conda" | "venv">(hasConda ? "conda" : "venv");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("3.12");
  const [base, setBase] = useState("");
  const [packages, setPackages] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onJob(
        await api.post<Job>("/api/envs/create/", {
          kind,
          name,
          python_version: kind === "conda" ? version : undefined,
          base_python: kind === "venv" ? base : undefined,
          packages: packages.split(/\s+/).filter(Boolean),
        }),
      );
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t("New environment")} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="row">
          <label className={`choice ${kind === "conda" ? "active" : ""}`}>
            <input type="radio" checked={kind === "conda"} disabled={!hasConda} onChange={() => setKind("conda")} /> {t("conda environment")}
          </label>
          <label className={`choice ${kind === "venv" ? "active" : ""}`}>
            <input type="radio" checked={kind === "venv"} onChange={() => setKind("venv")} /> {t("virtual environment (venv)")}
          </label>
        </div>
        <small className="muted">
          {kind === "conda"
            ? t("conda can install any Python version and non-Python libraries. The environment is also available in your terminal with conda activate.")
            : !hasConda
              ? t("conda was not found, so only virtual environments can be created.")
              : t("A venv uses an existing Python installation and installs packages with pip.")}
        </small>
        <label>
          {t("Name")}
          <input required dir="ltr" pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" value={name} onChange={(e) => setName(e.target.value)} placeholder="analysis" />
          <small className="muted">{t("Letters, digits, dots, dashes and underscores; no spaces.")}</small>
        </label>
        {kind === "conda" ? (
          <label>
            {t("Python version")}
            <input dir="ltr" list="py-versions" value={version} onChange={(e) => setVersion(e.target.value)} />
            <datalist id="py-versions">
              {["3.13", "3.12", "3.11", "3.10", "3.9"].map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </label>
        ) : (
          <label>
            {t("Based on")}
            <select value={base} onChange={(e) => setBase(e.target.value)}>
              <option value="">{t("The app's Python")}</option>
              {data?.envs
                .filter((e) => !e.is_app)
                .map((e) => (
                  <option key={e.id} value={e.python}>
                    {envLabel(e)}
                  </option>
                ))}
            </select>
            <small className="muted">{t("The new environment gets this Python's version.")}</small>
          </label>
        )}
        <label>
          {t("Packages to install (optional)")}
          <input dir="ltr" value={packages} onChange={(e) => setPackages(e.target.value)} placeholder="numpy pandas matplotlib" />
          <small className="muted">{t("ipykernel is always installed so notebooks can use the environment.")}</small>
        </label>
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="btn btn-primary" disabled={busy || !name}>
            {t("Create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AddEnvModal({ onClose, onAdded }: { onClose: () => void; onAdded: (e: PyEnv) => void }) {
  const [path, setPath] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onAdded(await api.post<PyEnv>("/api/envs/register/", { path }));
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <Modal title={t("Add an existing environment")} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          {t("Folder of the environment, or its Python")}
          <input required dir="ltr" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/me/projects/thesis/.venv" />
          <small className="muted">
            {t("For example a .venv folder, or the python executable inside it. conda environments are listed automatically when conda is found.")}
          </small>
        </label>
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="btn btn-primary">{t("Add")}</button>
        </div>
      </form>
    </Modal>
  );
}
