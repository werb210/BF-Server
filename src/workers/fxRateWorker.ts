// BF_SERVER_FX_RATE_WORKER_v355
// fx_rates.USD was seeded once at 1.37 (migration 2026_08_03) and never updated,
// so every CAD figure built from a USD deal used a stale rate. This refreshes it
// from the Bank of Canada's published daily USD/CAD rate (Valet API, no key).
import type { Pool } from "pg";

const VALET_URL = "https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1";

export function parseValetUsdCad(body: any): { rate: number; date: string } | null {
  const list = Array.isArray(body?.observations) ? body.observations : [];
  const obs = list[list.length - 1];
  const rate = Number(obs?.FXUSDCAD?.v);
  const date = String(obs?.d ?? "");
  if (!Number.isFinite(rate) || rate < 0.5 || rate > 3) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { rate, date };
}

export async function refreshUsdCadRate(
  pool: Pick<Pool, "query">,
  fetchImpl: typeof fetch = fetch,
): Promise<{ rate: number; date: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetchImpl(VALET_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`valet_http_${res.status}`);
    const parsed = parseValetUsdCad(await res.json());
    if (!parsed) throw new Error("valet_unparseable");
    await pool.query(
      `INSERT INTO fx_rates (currency, to_cad, updated_at) VALUES ('USD', $1, $2::date)
       ON CONFLICT (currency) DO UPDATE SET to_cad = EXCLUDED.to_cad, updated_at = EXCLUDED.updated_at`,
      [parsed.rate, parsed.date],
    );
    console.log("[fx] USD->CAD updated", parsed);
    return parsed;
  } catch (err: any) {
    // The last good rate stays in place; never block anything on this.
    console.error("[fx] USD->CAD refresh failed", { message: err?.message || String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function startFxRateWorker(pool: Pick<Pool, "query">): { stop: () => void } {
  void refreshUsdCadRate(pool);
  const handle = setInterval(() => { void refreshUsdCadRate(pool); }, 6 * 60 * 60 * 1000);
  (handle as any).unref?.();
  return { stop: () => clearInterval(handle) };
}
