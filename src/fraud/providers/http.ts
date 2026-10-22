// BF_SERVER_v846_FRAUD - one small fetch wrapper for every outside service the fraud checks call: a timeout, JSON in
// and out, and a result instead of a throw. Tests pass their own fetch.
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }>;

export type HttpResult = { ok: true; status: number; body: any } | { ok: false; status: number | null; error: string };

export const DEFAULT_TIMEOUT_MS = 8_000;

export function defaultFetch(): FetchLike {
  return globalThis.fetch as unknown as FetchLike;
}

export async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
): Promise<HttpResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const r = await fetchImpl(url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { Accept: "application/json", ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...(init.headers ?? {}) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: ctrl.signal,
    });
    let body: any = null;
    try { body = await r.json(); } catch { body = null; }
    if (!r.ok) return { ok: false, status: r.status, error: `status_${r.status}` };
    return { ok: true, status: r.status, body };
  } catch (err) {
    return { ok: false, status: null, error: (err as { name?: string; message?: string })?.name === "AbortError" ? "timeout" : (err as Error)?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Tests never reach the network unless they pass a fetch of their own. */
export function networkAllowed(fetchImpl: FetchLike | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(fetchImpl) || env.NODE_ENV !== "test";
}
