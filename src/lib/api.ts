import { ApiResponseSchema } from "@/contracts";
import { API_BASE } from "../config/api";

type ApiMethod = "get" | "post";

const buildUrl = (path: string): string => `${API_BASE}${path}`;

const logRequest = (method: ApiMethod, path: string): void => {
  console.log("[CLIENT → API]", {
    url: buildUrl(path),
    method,
  });
};

const safeJson = async (response: Response): Promise<unknown> => {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

const parseApiResponse = async (res: Response): Promise<unknown> => {
  const json = await safeJson(res);
  const parsed = ApiResponseSchema.safeParse(json);

  if (!parsed.success) {
    throw new Error("API contract violation");
  }

  if (parsed.data.status !== "ok") {
    throw new Error(parsed.data.error);
  }

  return parsed.data.data;
};

export const apiFetch = (path: string, options?: RequestInit) => {
  logRequest((options?.method?.toLowerCase() as ApiMethod) ?? "get", path);
  return fetch(buildUrl(path), {
    ...options,
  });
};

const api = {
  get: async (path: string, opts?: RequestInit) => {
    logRequest("get", path);
    const res = await fetch(buildUrl(path), { ...opts });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseApiResponse(res);
  },
  post: async (path: string, body?: unknown, opts?: RequestInit) => {
    logRequest("post", path);
    const res = await fetch(buildUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...opts,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseApiResponse(res);
  },
};

export default api;

/**
 * REQUIRED: restore named exports expected by client
 */
export const safeApiFetch = async (...args: unknown[]) => {
  try {
    return await (api.get as (...apiArgs: unknown[]) => Promise<unknown>)(...args);
  } catch (err) {
    console.error("safeApiFetch error", err);
    return null;
  }
};
