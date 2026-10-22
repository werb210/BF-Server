// BF_SERVER_v846_FRAUD - Boreal's link to Keystone operations (KS-Ops), used only for the shared fraud watchlist.
// Boreal is a member of the Keystone watchlist; nothing else is sent to Keystone.
//   KS_OPS_URL      KS-Ops base URL
//   KS_LICENSEE_ID  the id KS-Ops gave Boreal
//   KS_OPS_KEY      shared secret, sent as X-KS-Ops-Key
// Every call is best effort: a failure is returned (and logged by the caller), never thrown.

export type OpsConfig = { url: string; licenseeId: string; key: string };
export type OpsFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }>;

export type OpsResult = { ok: true; status: number; body: any } | { ok: false; status: number | null; error: string };

export const OPS_TIMEOUT_MS = 15_000;

/** The link settings, or null when any of the three is missing. */
export function opsConfig(env: NodeJS.ProcessEnv = process.env): OpsConfig | null {
  const url = String(env.KS_OPS_URL ?? "").trim().replace(/\/+$/, "");
  const licenseeId = String(env.KS_LICENSEE_ID ?? "").trim();
  const key = String(env.KS_OPS_KEY ?? "").trim();
  if (!url || !licenseeId || !key) return null;
  return { url, licenseeId, key };
}

/** POST {KS_OPS_URL}/api/licensees/{KS_LICENSEE_ID}/{path} with the ops key. */
export async function postToOps(
  path: "watchlist/report" | "watchlist/withdraw" | "watchlist/check" | "watchlist/opt-in",
  body: unknown,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: OpsFetch } = {},
): Promise<OpsResult> {
  const cfg = opsConfig(opts.env);
  if (!cfg) return { ok: false, status: null, error: "ops_not_configured" };
  const doFetch: OpsFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as OpsFetch);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OPS_TIMEOUT_MS);
  try {
    const r = await doFetch(`${cfg.url}/api/licensees/${encodeURIComponent(cfg.licenseeId)}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KS-Ops-Key": cfg.key },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      let detail = "";
      try { detail = (await r.text()).slice(0, 200); } catch (err) { detail = String(err).slice(0, 200); }
      return { ok: false, status: r.status, error: `status_${r.status}${detail ? `: ${detail}` : ""}` };
    }
    let parsed: any = null;
    try { parsed = await r.json(); } catch (err) { console.warn("[fraud-ops-link] reply was not JSON", path, String(err)); }
    return { ok: true, status: r.status, body: parsed };
  } catch (err) {
    return { ok: false, status: null, error: (err as { message?: string })?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}
