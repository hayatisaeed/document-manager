import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { toastError } from "./Toast";
import { t } from "../i18n";
import type { Job } from "../types";

const POLL_MS = 600;

/**
 * Live output of a background task (package install, environment creation).
 * Calls ``onDone`` once when the task finishes, whatever the outcome.
 */
export default function JobLog({ job, onDone, compact }: { job: Job; onDone?: (job: Job) => void; compact?: boolean }) {
  const [state, setState] = useState<Job>(job);
  const [lines, setLines] = useState<string[]>([]);
  const [open, setOpen] = useState(!compact);
  const pre = useRef<HTMLPreElement>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let since = 0;
    let stopped = false;
    let timer: number | undefined;
    setLines([]);
    const poll = async () => {
      try {
        const r = await api.get<Job>(`/api/jobs/${job.id}/?since=${since}`);
        if (stopped) return;
        since = r.next ?? since;
        if (r.lines?.length) setLines((ls) => [...ls, ...r.lines!].slice(-3000));
        setState(r);
        if (r.state === "running") timer = window.setTimeout(poll, POLL_MS);
        else done.current?.(r);
      } catch (e) {
        if (!stopped) toastError(e);
      }
    };
    poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [job.id]);

  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [lines, open]);

  const cancel = () => api.post(`/api/jobs/${job.id}/cancel/`).catch(toastError);
  const label =
    state.state === "running" ? t("Working…") : state.state === "succeeded" ? t("Finished") : state.state === "cancelled" ? t("Cancelled") : t("Failed");

  return (
    <div className={`job job-${state.state}`}>
      <div className="row between">
        <span className="row tight">
          {state.state === "running" && <span className="kernel-dot busy" />}
          <strong dir="auto">{state.title}</strong>
          <span className={`badge job-state-${state.state}`}>{label}</span>
        </span>
        <span className="row tight">
          <button className="btn btn-sm" onClick={() => setOpen(!open)}>
            {open ? t("Hide details") : t("Show details")}
          </button>
          {state.state === "running" && (
            <button className="btn btn-sm btn-danger" onClick={cancel}>
              {t("Cancel")}
            </button>
          )}
        </span>
      </div>
      {state.state === "failed" && state.error && <div className="error-text small">{state.error}</div>}
      {open && (
        <pre ref={pre} className="git-output job-output" dir="ltr">
          {lines.join("\n") || "…"}
        </pre>
      )}
    </div>
  );
}
