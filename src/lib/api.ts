const api = {
  get: async (url: string, opts?: RequestInit) => {
    const res = await fetch(url, { credentials: "include", ...opts });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  post: async (url: string, body?: any, opts?: RequestInit) => {
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...opts,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
};

export default api;

/**
 * REQUIRED: restore named exports expected by client
 */
export const apiFetch = api;

export const safeApiFetch = async (...args: any[]) => {
  try {
    return await (api.get as (...apiArgs: any[]) => Promise<any>)(...args);
  } catch (err) {
    console.error("safeApiFetch error", err);
    return null;
  }
};
