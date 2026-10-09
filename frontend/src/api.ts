export class ApiError extends Error {
  status: number;
  /** Machine-readable error details from the server, e.g. {code: "missing_ipykernel", env: "…"}. */
  data: Record<string, unknown>;
  constructor(message: string, status: number, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function apiError(res: Response): Promise<ApiError> {
  try {
    const data = await res.json();
    if (typeof data?.detail === "string") return new ApiError(data.detail, res.status, data);
    return new ApiError(JSON.stringify(data), res.status);
  } catch {
    return new ApiError(`${res.status} ${res.statusText}`, res.status);
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
  if (!res.ok) throw await apiError(res);
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
  if (!res.ok) throw await apiError(res);
  const blob = await res.blob();
  const match = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = match?.[1] ?? fallbackName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
