"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeApiFetch = exports.apiFetch = void 0;
const api = {
    get: async (url, opts) => {
        const res = await fetch(url, { credentials: "include", ...opts });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        return res["json"]();
    },
    post: async (url, body, opts) => {
        const res = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            ...opts,
        });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        return res["json"]();
    },
};
exports.default = api;
/**
 * REQUIRED: restore named exports expected by client
 */
exports.apiFetch = api;
const safeApiFetch = async (...args) => {
    try {
        return await api.get(...args);
    }
    catch (err) {
        console.error("safeApiFetch error", err);
        return null;
    }
};
exports.safeApiFetch = safeApiFetch;
