// BF_SERVER_v913_CHATGPT_ADS - read-and-steer client for the OpenAI Ads (ChatGPT Ads) Advertiser API.
// Base https://api.ads.openai.com/v1, Bearer key from Ads Manager (pasted in Settings > Your services as
// OPENAI_ADS_API_KEY; an Azure setting wins). Only what the Marketing > Ads > ChatGPT tab needs: list campaigns,
// campaign totals for a date range, pause and activate. Nothing here creates campaigns or spends money.
export const CHATGPT_ADS_BASE = "https://api.ads.openai.com/v1";

export type CampaignRow = {
  id: string; name: string; status: string; bidding_type: string | null; lifetime_budget: number | null;
  impressions: number; clicks: number; spend: number; ctr: number | null; cpc: number | null; conversions: number;
};

export class ChatgptAdsError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

type Fetch = typeof fetch;

export function chatgptAdsKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const k = String(env.OPENAI_ADS_API_KEY ?? "").trim();
  return k || null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** since/until as YYYY-MM-DD; until is clamped to today (the API rejects future bounds). */
export function dateRange(since: unknown, until: unknown, now = new Date()): { since: string; until: string } {
  const today = now.toISOString().slice(0, 10);
  const u = typeof until === "string" && DATE.test(until) && until <= today ? until : today;
  const def = new Date(now.getTime() - 29 * 86400000).toISOString().slice(0, 10);
  const s = typeof since === "string" && DATE.test(since) && since <= u ? since : (def <= u ? def : u);
  return { since: s, until: u };
}

async function call(key: string, path: string, init: { method?: string; query?: Record<string, string | string[]> } = {}, f: Fetch = fetch): Promise<any> {
  const url = new URL(CHATGPT_ADS_BASE + path);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, one);
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await f(url.toString(), { method: init.method ?? "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: ctl.signal });
    const text = await r.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!r.ok) {
      const msg = String(body?.error?.message ?? body?.message ?? `ChatGPT Ads answered ${r.status}`);
      const code = r.status === 401 ? "bad_key" : r.status === 403 ? "not_enabled" : r.status === 429 ? "rate_limited" : "api_error";
      throw new ChatgptAdsError(r.status, code, msg);
    }
    return body;
  } catch (err) {
    if (err instanceof ChatgptAdsError) throw err;
    throw new ChatgptAdsError(502, "unreachable", `ChatGPT Ads could not be reached: ${String((err as Error)?.message ?? err)}`);
  } finally { clearTimeout(t); }
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Every campaign (paged) joined with its totals for the range. Archived campaigns are left out. */
export async function campaignsWithTotals(key: string, range: { since: string; until: string }, f: Fetch = fetch): Promise<CampaignRow[]> {
  const campaigns: any[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const q: Record<string, string> = { limit: "500" };
    if (after) q.after = after;
    const r = await call(key, "/campaigns", { query: q }, f);
    campaigns.push(...(Array.isArray(r?.data) ? r.data : []));
    if (!r?.has_more || !r?.last_id) break;
    after = String(r.last_id);
  }
  const totals = new Map<string, any>();
  after = null;
  for (let page = 0; page < 10; page++) {
    const q: Record<string, string | string[]> = {
      "time_ranges[]": JSON.stringify({ type: "date_range", since: range.since, until: range.until }),
      time_granularity: "none",
      aggregation_level: "campaign",
      "fields[]": ["campaign.impressions", "campaign.clicks", "campaign.spend", "campaign.ctr", "campaign.cpc", "campaign.conversions"],
      limit: "2000",
    };
    if (after) q.after = after;
    const r = await call(key, "/ad_account/insights", { query: q }, f);
    for (const row of Array.isArray(r?.data) ? r.data : []) totals.set(String(row.campaign_id ?? row.id), row);
    if (!r?.has_more || !r?.last_id) break;
    after = String(r.last_id);
  }
  return campaigns
    .filter((c) => String(c?.status ?? "") !== "archived")
    .map((c) => {
      const t = totals.get(String(c.id)) ?? {};
      const budget = numOrNull(c?.budget?.lifetime_spend_limit_micros);
      return {
        id: String(c.id), name: String(c.name ?? c.id), status: String(c.status ?? "unknown"), bidding_type: c.bidding_type ?? null,
        lifetime_budget: budget === null ? null : budget / 1_000_000,
        impressions: num(t.impressions), clicks: num(t.clicks), spend: num(t.spend), ctr: numOrNull(t.ctr), cpc: numOrNull(t.cpc), conversions: num(t.conversions),
      };
    })
    .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name));
}

export async function setCampaignState(key: string, id: string, state: "pause" | "activate", f: Fetch = fetch): Promise<{ id: string; status: string }> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new ChatgptAdsError(400, "bad_id", "That campaign id is not valid.");
  const r = await call(key, `/campaigns/${id}/${state}`, { method: "POST" }, f);
  return { id: String(r?.id ?? id), status: String(r?.status ?? (state === "pause" ? "paused" : "active")) };
}
