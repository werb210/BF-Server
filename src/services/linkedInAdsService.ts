// BF_SERVER_LINKEDIN_ADS_v1 - LinkedIn Ads spend/performance via the LinkedIn
// Marketing adAnalytics API. Env-gated like Google Ads/GA4: returns
// { configured:false } until LINKEDIN_ADS_* credentials are set, so the portal
// degrades gracefully. Mirrors googleAdsService's shape. In-memory cached.
import { logError } from "../observability/logger.js";

// LinkedIn ships a new versioned Marketing API monthly (YYYYMM), supported for
// >=1 year. Bump via LINKEDIN_API_VERSION env when the current one nears sunset.
const API_VERSION = String(process.env.LINKEDIN_API_VERSION || "202605");
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const REST_BASE = "https://api.linkedin.com/rest";

export type LiAdsRow = { name: string; cost: number; impressions: number; clicks: number; ctr: number; cpc: number; conversions: number };
export type LiAdsReport = {
  configured: true;
  days: number;
  cached: boolean;
  totals: { cost: number; impressions: number; clicks: number; conversions: number; ctr: number; cpc: number; cpa: number };
  campaigns: LiAdsRow[];
  error?: string;
};
export type LiAdsNotConfigured = { configured: false };

export function linkedInAdsConfigured(): boolean {
  return Boolean(
    process.env.LINKEDIN_ADS_CLIENT_ID &&
    process.env.LINKEDIN_ADS_CLIENT_SECRET &&
    process.env.LINKEDIN_ADS_REFRESH_TOKEN &&
    process.env.LINKEDIN_ADS_ACCOUNT_ID,
  );
}

// LinkedIn access tokens expire (60-day refresh-token rotation); refresh on
// demand and cache until just before expiry.
let tokenCache: { token: string; expiresAt: number } | null = null;
async function getAccessToken(): Promise<string> {
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
const numv = (v: unknown): number => Number(v ?? 0);
// LinkedIn returns cost fields as strings -- cast to float before arithmetic.
const moneyv = (v: unknown): number => { const n = parseFloat(String(v ?? "0")); return Number.isFinite(n) ? n : 0; };

function liDateRange(days: number): string {
  const end = new Date();
  const start = new Date(Date.now() - days * 86_400_000);
  const p = (d: Date) => `(year:${d.getUTCFullYear()},month:${d.getUTCMonth() + 1},day:${d.getUTCDate()})`;
  return `(start:${p(start)},end:${p(end)})`;
}

const CACHE_MS = 5 * 60_000;
const reportCache = new Map<number, { at: number; report: LiAdsReport }>();

export async function runLinkedInAdsReport(days: number): Promise<LiAdsReport | LiAdsNotConfigured> {
  if (!linkedInAdsConfigured()) return { configured: false };
  const cached = reportCache.get(days);
  if (cached && Date.now() - cached.at < CACHE_MS) return { ...cached.report, cached: true };

  const base: LiAdsReport = {
    configured: true, days, cached: false,
    totals: { cost: 0, impressions: 0, clicks: 0, conversions: 0, ctr: 0, cpc: 0, cpa: 0 },
    campaigns: [],
  };
  try {
    const token = await getAccessToken();
    const acct = `urn:li:sponsoredAccount:${accountId()}`;
    const params = [
      "q=analytics",
      "pivot=CAMPAIGN",
      "timeGranularity=ALL",
      `dateRange=${liDateRange(days)}`,
      `accounts=List(${encodeURIComponent(acct)})`,
      "fields=impressions,clicks,costInLocalCurrency,externalWebsiteConversions,pivotValues",
    ].join("&");
    const resp = await fetch(`${REST_BASE}/adAnalytics?${params}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Linkedin-Version": API_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      },
    });
    if (!resp.ok) {
      throw new Error(`linkedin_ads_analytics status=${resp.status} ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    }
    const j = (await resp.json()) as { elements?: Array<Record<string, unknown>> };
    for (const el of j.elements ?? []) {
      const impressions = numv(el.impressions);
      const clicks = numv(el.clicks);
      const cost = moneyv(el.costInLocalCurrency);
      const conversions = numv(el.externalWebsiteConversions);
      const pv = el.pivotValues;
      const urn = Array.isArray(pv) ? String(pv[0] ?? "") : "";
      const tail = urn.split(":").pop() || urn;
      base.campaigns.push({
        name: tail ? `Campaign ${tail}` : "Campaign",
        cost, impressions, clicks, conversions,
        ctr: impressions ? clicks / impressions : 0,
        cpc: clicks ? cost / clicks : 0,
      });
      base.totals.cost += cost;
      base.totals.impressions += impressions;
      base.totals.clicks += clicks;
      base.totals.conversions += conversions;
    }
    base.totals.ctr = base.totals.impressions ? base.totals.clicks / base.totals.impressions : 0;
    base.totals.cpc = base.totals.clicks ? base.totals.cost / base.totals.clicks : 0;
    base.totals.cpa = base.totals.conversions ? base.totals.cost / base.totals.conversions : 0;
    base.campaigns.sort((a, b) => b.cost - a.cost);
    reportCache.set(days, { at: Date.now(), report: base });
    return base;
  } catch (e) {
    logError("linkedin_ads_report_failed", { error: e instanceof Error ? e.message : String(e) });
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}
