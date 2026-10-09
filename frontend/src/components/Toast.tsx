import { useEffect, useState } from "react";

type Toast = { id: number; message: string; kind: "info" | "error" | "success" };
let listeners: ((t: Toast) => void)[] = [];
let nextId = 1;

export function toast(message: string, kind: Toast["kind"] = "info") {
  const t = { id: nextId++, message, kind };
  listeners.forEach((l) => l(t));
}

export function toastError(err: unknown) {
  toast(err instanceof Error ? err.message : String(err), "error");
}

export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    const l = (t: Toast) => {
      setToasts((ts) => [...ts, t]);
      setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== t.id)), t.kind === "error" ? 9000 : 3500);
    };
    listeners.push(l);
    return () => {
      listeners = listeners.filter((x) => x !== l);
    };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
