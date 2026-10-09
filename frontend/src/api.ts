export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.detail === "string") return data.detail;
    return JSON.stringify(data);
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

export async function request<T = unknown>(
  method: string,
  url: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = { method, headers: { "X-DM-Client": "1" } };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T,>(url: string) => request<T>("GET", url),
  post: <T,>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T,>(url: string, body?: unknown) => request<T>("PUT", url, body ?? {}),
  patch: <T,>(url: string, body?: unknown) => request<T>("PATCH", url, body ?? {}),
  del: <T,>(url: string) => request<T>("DELETE", url),
};

export function qs(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Project-scoped URL helper: p("git/status/") -> /api/projects/<slug>/git/status/ */
export function projectApi(slug: string) {
  return (path: string) => `/api/projects/${slug}/${path}`;
}

/** POST and save the response body as a downloaded file. */
export async function download(url: string, body: unknown, fallbackName: string): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-DM-Client": "1" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
  const blob = await res.blob();
  const match = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = match?.[1] ?? fallbackName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
