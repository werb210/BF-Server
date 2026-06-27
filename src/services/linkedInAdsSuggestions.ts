// BF_SERVER_LINKEDIN_SUGGESTIONS_v1 - Maya's LinkedIn campaign recommendations
// + apply. Rule-based (deterministic, explainable) over live adAnalytics data:
// pause wasteful campaigns (spend with zero conversions). NOTHING changes in the
// account until a human approves (POST .../apply), which runs ONE scoped
// adCampaigns partial-update. Env-gated; self-contained token fetch.
import { createHash } from "crypto";
import { logError } from "../observability/logger.js";

const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const REST_BASE = "https://api.linkedin.com/rest";
const API_VERSION = String(process.env.LINKEDIN_API_VERSION || "202605");
const CAMP_WASTE_COST = Number(process.env.LINKEDIN_ADS_CAMP_WASTE_COST || 200);

export function linkedInSuggestionsConfigured(): boolean {
  return Boolean(
    process.env.LINKEDIN_ADS_CLIENT_ID &&
    process.env.LINKEDIN_ADS_CLIENT_SECRET &&
    process.env.LINKEDIN_ADS_REFRESH_TOKEN &&
    process.env.LINKEDIN_ADS_ACCOUNT_ID,
  );
}

export type LiAdAction = { type: "pause_campaign"; campaignId: string };
export type LiSuggestion = { id: string; kind: string; title: string; rationale: string; severity: "info" | "warn"; action: LiAdAction };

let tokenCache: { token: string; expiresAt: number } | null = null;
async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: String(process.env.LINKEDIN_ADS_REFRESH_TOKEN),
    client_id: String(process.env.LINKEDIN_ADS_CLIENT_ID),
    client_secret: String(process.env.LINKEDIN_ADS_CLIENT_SECRET),
  });
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`linkedin_ads_token_failed status=${r.status}`);
  const j = (await r.json()) as { access_token?: string; expires_in?: number };
  const token = String(j.access_token ?? "");
  if (!token) throw new Error("linkedin_ads_token_empty");
  tokenCache = { token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return token;
}

function accountId(): string { return String(process.env.LINKEDIN_ADS_ACCOUNT_ID).replace(/[^0-9]/g, ""); }
const moneyv = (v: unknown): number => { const n = parseFloat(String(v ?? "0")); return Number.isFinite(n) ? n : 0; };
const numv = (v: unknown): number => Number(v ?? 0);
const sid = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Linkedin-Version": API_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

// Best-effort campaign name lookup (batch get). Never throws.
async function campaignNames(token: string, ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!ids.length) return out;
  try {
    const resp = await fetch(`${REST_BASE}/adCampaigns?ids=List(${ids.join(",")})`, { headers: authHeaders(token) });
    if (!resp.ok) return out;
    const j = (await resp.json()) as { results?: Record<string, { name?: string }> };
    for (const [k, v] of Object.entries(j.results ?? {})) { if (v?.name) out[k] = String(v.name); }
  } catch { /* best effort */ }
  return out;
}

export async function buildLinkedInSuggestions(days: number): Promise<{ configured: boolean; suggestions: LiSuggestion[] }> {
  if (!linkedInSuggestionsConfigured()) return { configured: false, suggestions: [] };
  const suggestions: LiSuggestion[] = [];
  try {
    const token = await accessToken();
    const end = new Date();
    const start = new Date(Date.now() - days * 86_400_000);
    const p = (d: Date) => `(year:${d.getUTCFullYear()},month:${d.getUTCMonth() + 1},day:${d.getUTCDate()})`;
    const range = `(start:${p(start)},end:${p(end)})`;
    const acct = `urn:li:sponsoredAccount:${accountId()}`;
    const params = [
      "q=analytics", "pivot=CAMPAIGN", "timeGranularity=ALL",
      `dateRange=${range}`, `accounts=List(${encodeURIComponent(acct)})`,
      "fields=costInLocalCurrency,externalWebsiteConversions,pivotValues",
    ].join("&");
    const resp = await fetch(`${REST_BASE}/adAnalytics?${params}`, { headers: authHeaders(token) });
    if (!resp.ok) throw new Error(`linkedin_ads_analytics status=${resp.status}`);
    const j = (await resp.json()) as { elements?: Array<Record<string, unknown>> };
    const rows = (j.elements ?? []).map((el) => {
      const pv = el.pivotValues;
      const urn = Array.isArray(pv) ? String(pv[0] ?? "") : "";
      const id = urn.split(":").pop() || "";
      return { id, cost: moneyv(el.costInLocalCurrency), conv: numv(el.externalWebsiteConversions) };
    }).filter((r) => r.id);
    const names = await campaignNames(token, rows.map((r) => r.id));
    for (const r of rows) {
      const label = names[r.id] || `Campaign ${r.id}`;
      if (r.conv === 0 && r.cost >= CAMP_WASTE_COST) {
        suggestions.push({
          id: sid("pc" + r.id),
          kind: "pause_campaign",
          title: `Pause campaign "${label}"`,
          rationale: `Spent $${r.cost.toFixed(0)} with 0 conversions over the last ${days} days.`,
          severity: "warn",
          action: { type: "pause_campaign", campaignId: r.id },
        });
      }
    }
    return { configured: true, suggestions };
  } catch (e) {
    logError("linkedin_ads_suggestions_failed", { error: e instanceof Error ? e.message : String(e) });
    return { configured: true, suggestions };
  }
}

// Apply ONE approved action - a single scoped adCampaigns partial-update.
export async function applyLinkedInSuggestion(action: LiAdAction): Promise<{ ok: boolean; error?: string }> {
  if (!linkedInSuggestionsConfigured()) return { ok: false, error: "not configured" };
  try {
    if (action.type === "pause_campaign") {
      const id = String(action.campaignId).replace(/[^0-9]/g, "");
      if (!id) return { ok: false, error: "missing campaignId" };
      const token = await accessToken();
      const resp = await fetch(`${REST_BASE}/adCampaigns/${id}`, {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json", "X-RestLi-Method": "PARTIAL_UPDATE" },
        body: JSON.stringify({ patch: { $set: { status: "PAUSED" } } }),
      });
      if (!resp.ok) return { ok: false, error: `status=${resp.status} ${(await resp.text().catch(() => "")).slice(0, 200)}` };
      return { ok: true };
    }
    return { ok: false, error: "unknown action" };
  } catch (e) {
    logError("linkedin_ads_apply_failed", { error: e instanceof Error ? e.message : "apply failed" });
    return { ok: false, error: e instanceof Error ? e.message : "apply failed" };
  }
}
