export const apiClient = {
  get: async (url: string, options?: RequestInit) => {
    const res = await fetch(url, { ...options, method: "GET" });
    return res.json();
  },

  post: async (url: string, body?: any) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  },

  patch: async (url: string, body?: any) => {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  },

  request: async (url: string, options: RequestInit) => {
    const res = await fetch(url, options);
    return res.json();
  },

  interceptors: {
    request: [] as Array<(options: RequestInit) => RequestInit | Promise<RequestInit>>,
    response: [] as Array<(response: Response) => Response | Promise<Response>>,
  },
};
