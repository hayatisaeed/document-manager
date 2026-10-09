import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import JobLog from "../components/JobLog";
import { toast, toastError } from "../components/Toast";
import { t } from "../i18n";
import { envLabel } from "../pages/EnvironmentsPage";
import type { EnvList, Job, ProjectEnv } from "../types";
import { useWorkspace } from "./context";

/** Project panel: the Python environment for this project's notebooks, and its shared environment file. */
export default function ProjectEnvSection() {
  const { p, slug, refreshStatus } = useWorkspace();
  const [info, setInfo] = useState<ProjectEnv | null>(null);
  const [list, setList] = useState<EnvList | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(slug);

  const load = useCallback(() => {
    api.get<ProjectEnv>(p("env/")).then(setInfo).catch(toastError);
    api.get<EnvList>("/api/envs/").then(setList).catch(() => {});
  }, [p]);
  useEffect(load, [load]);

  if (!info) return null;

  const choose = async (envId: string) => {
    try {
      setInfo(await api.put<ProjectEnv>(p("env/"), { env_id: envId || null }));
      toast(t("Notebooks in this project now use this environment. Restart running kernels to switch."), "success");
    } catch (e) {
      toastError(e);
    }
  };

  const exportFile = async () => {
    try {
      const r = await api.post<ProjectEnv & { file: string }>(p("env/export/"), {});
      setInfo(r);
      refreshStatus().catch(() => {});
      toast(t("Saved {file}. Commit it to share the environment with your co-authors.", { file: r.file }), "success");
    } catch (e) {
      toastError(e);
    }
  };

  const create = async (kind: "conda" | "venv") => {
    try {
      setBusy(true);
      setJob(await api.post<Job>(p("env/create/"), { kind, name }));
    } catch (e) {
      setBusy(false);
      toastError(e);
    }
  };

  const hasConda = !!list?.conda;
  const { files } = info;

  return (
    <>
      <h3>{t("Python environment")}</h3>
      <p className="muted small">
        {t("Notebooks in this project run in this environment, unless a notebook chooses its own. The choice is stored on this computer only.")}
      </p>
      {info.missing && (
        <p className="banner banner-warn">
          {t("The environment chosen for this project is no longer on this computer:")}{" "}
          <span className="mono" dir="ltr">
            {info.env_path}
          </span>
        </p>
      )}
      <div className="row">
        <select value={info.env?.id ?? ""} onChange={(e) => choose(e.target.value)} aria-label={t("Python environment")} style={{ flex: 1 }}>
          <option value="">
            {t("Default")} ({info.default.name}
            {info.default.python_version ? ` · Python ${info.default.python_version}` : ""})
          </option>
          {list?.envs
            .filter((e) => !e.is_app)
            .map((e) => (
              <option key={e.id} value={e.id}>
                {envLabel(e)}
                {e.has_ipykernel ? "" : ` · ${t("no ipykernel")}`}
              </option>
            ))}
        </select>
        <Link className="btn" to={info.env ? `/environments?env=${info.env.id}` : "/environments"}>
          {t("Packages…")}
        </Link>
      </div>

      <h4>{t("Share the environment")}</h4>
      <p className="muted small">
        {t(
          "Save the list of installed packages in the project (environment.yml for conda, requirements.txt for venv) and commit it. A co-author can then create the same environment with one click.",
        )}
      </p>
      <div className="row">
        <button className="btn" onClick={exportFile} disabled={!info.env}>
          {t("Save environment file")}
        </button>
        {!info.env && <small className="muted">{t("Choose an environment for the project first.")}</small>}
      </div>

      {(files.environment || files.requirements) && (
        <div className="form" style={{ marginTop: 12 }}>
          <p className="small">
            {t("This project has:")}{" "}
            {files.environment && <span className="badge mono">environment.yml</span>}{" "}
            {files.requirements && <span className="badge mono">requirements.txt</span>}
          </p>
          <label>
            {t("Name for the new environment")}
            <input dir="ltr" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="row">
            {files.environment && (
              <button className="btn btn-primary" onClick={() => create("conda")} disabled={!hasConda || busy}>
                {t("Create conda environment from environment.yml")}
              </button>
            )}
            {files.requirements && (
              <button className="btn btn-primary" onClick={() => create("venv")} disabled={busy}>
                {t("Create venv from requirements.txt")}
              </button>
            )}
          </div>
          {files.environment && !hasConda && <small className="muted">{t("conda was not found on this computer.")}</small>}
        </div>
      )}
      {job && (
        <JobLog
          job={job}
          compact
          onDone={(j) => {
            setBusy(false);
            if (j.state === "succeeded") {
              toast(t("The environment is ready and is now used by this project."), "success");
              setJob(null);
            }
            load();
          }}
        />
      )}
    </>
  );
}
