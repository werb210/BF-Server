import { ApiResponseSchema } from "../contracts/index.js";
import { API_BASE } from "../config/api.js";
const buildUrl = (path) => `${API_BASE}${path}`;
const logRequest = (method, path) => {
    console.log("[CLIENT → API]", {
        url: buildUrl(path),
        method,
    });
};
const safeJson = async (response) => {
    try {
        const text = await response.text();
        return text ? JSON.parse(text) : null;
    }
    catch {
        return null;
    }
};
const parseApiResponse = async (res) => {
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
export const apiFetch = (path, options) => {
    logRequest(options?.method?.toLowerCase() ?? "get", path);
    return fetch(buildUrl(path), {
        ...options,
    });
};
const api = {
    get: async (path, opts) => {
        logRequest("get", path);
        const res = await fetch(buildUrl(path), { ...opts });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        return parseApiResponse(res);
    },
    post: async (path, body, opts) => {
        logRequest("post", path);
        const res = await fetch(buildUrl(path), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            ...opts,
        });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        return parseApiResponse(res);
    },
};
export default api;
/**
 * REQUIRED: restore named exports expected by client
 */
export const safeApiFetch = async (...args) => {
    try {
        return await api.get(...args);
    }
    catch (err) {
        console.error("safeApiFetch error", err);
        return null;
    }
};
