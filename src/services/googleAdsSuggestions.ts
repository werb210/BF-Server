// BF_SERVER_GOOGLE_ADS_SUGGESTIONS_v1 - Maya's campaign recommendations + apply.
// Rule-based (deterministic, explainable) suggestions over live Google Ads data:
// pause wasteful keywords/campaigns, raise budget on strong performers. NOTHING
// changes in the account until a human approves a suggestion (POST .../apply),
// which runs a single Google Ads mutate. Resource names come straight from
// Google's own GAQL response, so an approved action targets exactly that object.
// Env-gated; self-contained token fetch.
import { createHash } from "crypto";
import { logError } from "../observability/logger.js";

const API_VERSION = "v18";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Thresholds (overridable by env).
const KW_WASTE_COST = Number(process.env.GOOGLE_ADS_KW_WASTE_COST || 50);
const CAMP_WASTE_COST = Number(process.env.GOOGLE_ADS_CAMP_WASTE_COST || 200);
const STRONG_ROAS = Number(process.env.GOOGLE_ADS_STRONG_ROAS || 3);

export function suggestionsConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN &&
    process.env.GOOGLE_ADS_CLIENT_ID &&
    process.env.GOOGLE_ADS_CLIENT_SECRET &&
    process.env.GOOGLE_ADS_REFRESH_TOKEN &&
    process.env.GOOGLE_ADS_CUSTOMER_ID,
  );
}

export type AdAction =
  | { type: "pause_campaign"; resourceName: string }
  | { type: "pause_keyword"; resourceName: string }
  | { type: "set_budget"; resourceName: string; amountMicros: number };
export type Suggestion = { id: string; kind: string; title: string; rationale: string; severity: "info" | "warn"; action: AdAction };

let tokenCache: { token: string; expiresAt: number } | null = null;
async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const body = new URLSearchParams({
    client_id: String(process.env.GOOGLE_ADS_CLIENT_ID),
    client_secret: String(process.env.GOOGLE_ADS_CLIENT_SECRET),
    refresh_token: String(process.env.GOOGLE_ADS_REFRESH_TOKEN),
    grant_type: "refresh_token",
  });
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`google_ads_token_failed status=${r.status}`);
  const j = (await r.json()) as { access_token?: string; expires_in?: number };
  const token = String(j.access_token ?? "");
  if (!token) throw new Error("google_ads_token_empty");
  tokenCache = { token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return token;
}

function cid(): string { return String(process.env.GOOGLE_ADS_CUSTOMER_ID).replace(/[^0-9]/g, ""); }
function headers(token: string): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${token}`, "developer-token": String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN), "Content-Type": "application/json" };
  const lc = String(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? "").replace(/[^0-9]/g, "");
  if (lc) h["login-customer-id"] = lc;
  return h;
}
const micros = (v: unknown): number => Number(v ?? 0) / 1_000_000;
const num = (v: unknown): number => Number(v ?? 0);
const sid = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function gaql(query: string): Promise<any[]> {
  const token = await accessToken();
  const out: any[] = [];
  let pageToken: string | undefined;
  do {
    const resp = await fetch(`https://googleads.googleapis.com/${API_VERSION}/customers/${cid()}/googleAds:search`, {
      method: "POST", headers: headers(token), body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }),
    });
    if (!resp.ok) throw new Error(`google_ads_search status=${resp.status} ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    const j = (await resp.json()) as { results?: any[]; nextPageToken?: string };
    for (const row of j.results ?? []) out.push(row);
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

export async function buildSuggestions(days: number): Promise<{ configured: boolean; suggestions: Suggestion[] }> {
  if (!suggestionsConfigured()) return { configured: false, suggestions: [] };
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const W = `segments.date BETWEEN '${start}' AND '${end}'`;
  const suggestions: Suggestion[] = [];
  try {
    const camps = await gaql(`SELECT campaign.resource_name, campaign.name, campaign.status, campaign_budget.resource_name, campaign_budget.amount_micros, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE ${W} AND campaign.status = 'ENABLED'`);
    for (const r of camps) {
      const cost = micros(r?.metrics?.costMicros);
      const conv = num(r?.metrics?.conversions);
      const val = num(r?.metrics?.conversionsValue);
      const name = String(r?.campaign?.name ?? "campaign");
      const rn = String(r?.campaign?.resourceName ?? "");
      if (!rn) continue;
      if (conv === 0 && cost >= CAMP_WASTE_COST) {
        suggestions.push({ id: sid("pc" + rn), kind: "pause_campaign", title: `Pause campaign "${name}"`, rationale: `Spent $${cost.toFixed(0)} with 0 conversions over the last ${days} days.`, severity: "warn", action: { type: "pause_campaign", resourceName: rn } });
      } else if (conv >= 3 && cost > 0 && val / cost >= STRONG_ROAS) {
        const budgetRn = String(r?.campaignBudget?.resourceName ?? "");
        const curMicros = Number(r?.campaignBudget?.amountMicros ?? 0);
        if (budgetRn && curMicros > 0) {
          const newMicros = Math.round(curMicros * 1.2);
          suggestions.push({ id: sid("bd" + budgetRn), kind: "set_budget", title: `Raise budget on "${name}" by 20%`, rationale: `Strong ROAS (${(val / cost).toFixed(1)}x) on ${conv.toFixed(0)} conversions - budget may be limiting reach.`, severity: "info", action: { type: "set_budget", resourceName: budgetRn, amountMicros: newMicros } });
        }
      }
    }
    const kws = await gaql(`SELECT ad_group_criterion.resource_name, ad_group_criterion.keyword.text, metrics.cost_micros, metrics.conversions FROM keyword_view WHERE ${W} AND ad_group_criterion.status = 'ENABLED' ORDER BY metrics.cost_micros DESC LIMIT 50`);
    for (const r of kws) {
      const cost = micros(r?.metrics?.costMicros);
      const conv = num(r?.metrics?.conversions);
      const text = String(r?.adGroupCriterion?.keyword?.text ?? "keyword");
      const rn = String(r?.adGroupCriterion?.resourceName ?? "");
      if (!rn) continue;
      if (conv === 0 && cost >= KW_WASTE_COST) {
        suggestions.push({ id: sid("pk" + rn), kind: "pause_keyword", title: `Pause keyword "${text}"`, rationale: `Spent $${cost.toFixed(0)} with 0 conversions over the last ${days} days.`, severity: "warn", action: { type: "pause_keyword", resourceName: rn } });
      }
    }
    return { configured: true, suggestions };
  } catch (e) {
    logError("google_ads_suggestions_failed");
    return { configured: true, suggestions };
  }
}

async function mutate(path: string, operation: any): Promise<{ ok: boolean; error?: string }> {
  const token = await accessToken();
  const resp = await fetch(`https://googleads.googleapis.com/${API_VERSION}/customers/${cid()}/${path}:mutate`, {
    method: "POST", headers: headers(token), body: JSON.stringify({ operations: [operation], partialFailure: true }),
  });
  const text = await resp.text().catch(() => "");
  if (!resp.ok) return { ok: false, error: `status=${resp.status} ${text.slice(0, 200)}` };
  let body: any = {}; try { body = JSON.parse(text); } catch { /* ignore */ }
  if (body?.partialFailureError) return { ok: false, error: JSON.stringify(body.partialFailureError).slice(0, 200) };
  return { ok: true };
}

// Apply ONE approved action. Each is a single, scoped mutate.
export async function applySuggestion(action: AdAction): Promise<{ ok: boolean; error?: string }> {
  if (!suggestionsConfigured()) return { ok: false, error: "not configured" };
  try {
    if (action.type === "pause_campaign") {
      return await mutate("campaigns", { update: { resourceName: action.resourceName, status: "PAUSED" }, updateMask: "status" });
    }
    if (action.type === "pause_keyword") {
      return await mutate("adGroupCriteria", { update: { resourceName: action.resourceName, status: "PAUSED" }, updateMask: "status" });
    }
    if (action.type === "set_budget") {
      return await mutate("campaignBudgets", { update: { resourceName: action.resourceName, amountMicros: String(action.amountMicros) }, updateMask: "amount_micros" });
    }
    return { ok: false, error: "unknown action" };
  } catch (e) {
    logError("google_ads_apply_failed");
    return { ok: false, error: e instanceof Error ? e.message : "apply failed" };
  }
}
