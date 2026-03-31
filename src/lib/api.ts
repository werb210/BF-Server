import { API_BASE } from "../config/api";

type ApiMethod = "get" | "post";

const buildUrl = (path: string): string => `${API_BASE}${path}`;

const logRequest = (method: ApiMethod, path: string): void => {
  console.log("[CLIENT → API]", {
    url: buildUrl(path),
    method,
  });
};

export const apiFetch = (path: string, options?: RequestInit) => {
  logRequest((options?.method?.toLowerCase() as ApiMethod) ?? "get", path);
  return fetch(buildUrl(path), {
    credentials: "include",
    ...options,
  });
};

const api = {
  get: async (path: string, opts?: RequestInit) => {
    logRequest("get", path);
    const res = await fetch(buildUrl(path), { credentials: "include", ...opts });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res["json"]();
  },
  post: async (path: string, body?: any, opts?: RequestInit) => {
    logRequest("post", path);
    const res = await fetch(buildUrl(path), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...opts,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res["json"]();
  },
};

export default api;

/**
 * REQUIRED: restore named exports expected by client
 */
export const safeApiFetch = async (...args: any[]) => {
  try {
    return await (api.get as (...apiArgs: any[]) => Promise<any>)(...args);
  } catch (err) {
    console.error("safeApiFetch error", err);
    return null;
  }
};
