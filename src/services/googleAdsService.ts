// BF_SERVER_GOOGLE_ADS_SERVICE_v1 - Google Ads reporting via the Google Ads API
// (GAQL search). Env-gated like GA4/Clarity: returns { configured:false } until
// credentials are set, so the portal degrades gracefully. In-memory cached.
import { logError } from "../observability/logger.js";

const API_VERSION = "v24";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type AdsRow = { name: string; status?: string; cost: number; impressions: number; clicks: number; ctr: number; cpc: number; conversions: number; convValue: number };
export type AdsReport = {
  configured: true;
  days: number;
  cached: boolean;
  totals: { cost: number; impressions: number; clicks: number; conversions: number; convValue: number; cpa: number; roas: number };
  campaigns: AdsRow[];
  keywords: AdsRow[];
  searchTerms: AdsRow[];
  error?: string;
};
export type AdsNotConfigured = { configured: false };

export function googleAdsConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN &&
    process.env.GOOGLE_ADS_CLIENT_ID &&
    process.env.GOOGLE_ADS_CLIENT_SECRET &&
    process.env.GOOGLE_ADS_REFRESH_TOKEN &&
    process.env.GOOGLE_ADS_CUSTOMER_ID,
  );
}

let tokenCache: { token: string; expiresAt: number } | null = null;
async function getAccessToken(): Promise<string> {
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
function loginCid(): string { return String(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? "").replace(/[^0-9]/g, ""); }
const micros = (v: unknown): number => Number(v ?? 0) / 1_000_000;
const num = (v: unknown): number => Number(v ?? 0);

export async function googleAdsSearch(query: string): Promise<any[]> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "developer-token": String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN),
    "Content-Type": "application/json",
  };
  const lc = loginCid();
  if (lc) headers["login-customer-id"] = lc;
  const out: any[] = [];
  let pageToken: string | undefined;
  do {
    const resp = await fetch(`https://googleads.googleapis.com/${API_VERSION}/customers/${cid()}/googleAds:search`, {
      method: "POST", headers, body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }),
    });
    if (!resp.ok) throw new Error(`google_ads_search status=${resp.status} ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    const j = (await resp.json()) as { results?: any[]; nextPageToken?: string };
    for (const row of j.results ?? []) out.push(row);
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

function dateRange(days: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date(Date.now() - days * 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

let reportCache = new Map<number, { at: number; report: AdsReport }>();
const CACHE_MS = 30 * 60_000;

export async function runGoogleAdsReport(days: number): Promise<AdsReport | AdsNotConfigured> {
  if (!googleAdsConfigured()) return { configured: false };
  const cached = reportCache.get(days);
  if (cached && Date.now() - cached.at < CACHE_MS) return { ...cached.report, cached: true };
  const { start, end } = dateRange(days);
  const W = `segments.date BETWEEN '${start}' AND '${end}'`;
  const base: AdsReport = { configured: true, days, cached: false, totals: { cost: 0, impressions: 0, clicks: 0, conversions: 0, convValue: 0, cpa: 0, roas: 0 }, campaigns: [], keywords: [], searchTerms: [] };
  try {
    const [camp, kw, st] = await Promise.all([
      googleAdsSearch(`SELECT campaign.name, campaign.status, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.conversions, metrics.conversions_value FROM campaign WHERE ${W} ORDER BY metrics.cost_micros DESC`),
      googleAdsSearch(`SELECT ad_group_criterion.keyword.text, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.conversions, metrics.conversions_value FROM keyword_view WHERE ${W} ORDER BY metrics.cost_micros DESC LIMIT 25`),
      googleAdsSearch(`SELECT search_term_view.search_term, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.conversions, metrics.conversions_value FROM search_term_view WHERE ${W} ORDER BY metrics.impressions DESC LIMIT 25`),
    ]);
    const mapRow = (name: string, status: string | undefined, m: any): AdsRow => ({
      name, ...(status ? { status } : {}), cost: micros(m?.costMicros), impressions: num(m?.impressions), clicks: num(m?.clicks), ctr: num(m?.ctr), cpc: micros(m?.averageCpc), conversions: num(m?.conversions), convValue: num(m?.conversionsValue),
    });
    base.campaigns = camp.map((r) => mapRow(String(r?.campaign?.name ?? "(unnamed)"), String(r?.campaign?.status ?? ""), r?.metrics));
    base.keywords = kw.map((r) => mapRow(String(r?.adGroupCriterion?.keyword?.text ?? "(none)"), undefined, r?.metrics));
    base.searchTerms = st.map((r) => mapRow(String(r?.searchTermView?.searchTerm ?? "(none)"), undefined, r?.metrics));
    for (const c of base.campaigns) {
      base.totals.cost += c.cost; base.totals.impressions += c.impressions; base.totals.clicks += c.clicks;
      base.totals.conversions += c.conversions; base.totals.convValue += c.convValue;
    }
    base.totals.cpa = base.totals.conversions ? Math.round((base.totals.cost / base.totals.conversions) * 100) / 100 : 0;
    base.totals.roas = base.totals.cost ? Math.round((base.totals.convValue / base.totals.cost) * 100) / 100 : 0;
    reportCache.set(days, { at: Date.now(), report: base });
    return base;
  } catch (e) {
    logError("google_ads_report_failed");
    return { ...base, error: e instanceof Error ? e.message : "Google Ads request failed" };
  }
}

// BF_SERVER_GOOGLE_ADS_DIAGNOSTICS_v1 - "test Google Ads now". Reports which of
// the five credentials are present, then (if all present) does a live token
// exchange + a trivial GAQL call, mapping the exact failure to a plain
// diagnosis so setup is a checklist, not a guessing game. Never returns secrets.
export async function googleAdsDiagnostics(): Promise<{
  devTokenSet: boolean; clientIdSet: boolean; clientSecretSet: boolean;
  refreshTokenSet: boolean; customerIdSet: boolean; loginCustomerIdSet: boolean;
  customerId: string | null; loginCustomerId: string | null;
  missing: string[]; tokenExchange?: string; apiCall?: string; diagnosis: string;
}> {
  const devTokenSet = Boolean(process.env.GOOGLE_ADS_DEVELOPER_TOKEN);
  const clientIdSet = Boolean(process.env.GOOGLE_ADS_CLIENT_ID);
  const clientSecretSet = Boolean(process.env.GOOGLE_ADS_CLIENT_SECRET);
  const refreshTokenSet = Boolean(process.env.GOOGLE_ADS_REFRESH_TOKEN);
  const customerIdSet = Boolean(process.env.GOOGLE_ADS_CUSTOMER_ID);
  const loginCustomerIdSet = Boolean(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
  const missing: string[] = [];
  if (!devTokenSet) missing.push("GOOGLE_ADS_DEVELOPER_TOKEN");
  if (!clientIdSet) missing.push("GOOGLE_ADS_CLIENT_ID");
  if (!clientSecretSet) missing.push("GOOGLE_ADS_CLIENT_SECRET");
  if (!refreshTokenSet) missing.push("GOOGLE_ADS_REFRESH_TOKEN");
  if (!customerIdSet) missing.push("GOOGLE_ADS_CUSTOMER_ID");
  const base = {
    devTokenSet, clientIdSet, clientSecretSet, refreshTokenSet, customerIdSet, loginCustomerIdSet,
    customerId: customerIdSet ? cid() : null,
    loginCustomerId: loginCustomerIdSet ? loginCid() : null,
    missing,
  };
  if (missing.length) {
    return { ...base, diagnosis: `missing_env: ${missing.join(", ")}` };
  }
  // Step 1: refresh token -> access token.
  let accessToken = "";
  try {
    tokenCache = null; // force a fresh exchange for the test
    accessToken = await getAccessToken();
  } catch (e) {
    return { ...base, tokenExchange: e instanceof Error ? e.message : String(e), diagnosis: "refresh_token_or_oauth_client_invalid" };
  }
  // Step 2: a trivial GAQL call to confirm the dev token + customer id work.
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN),
      "Content-Type": "application/json",
    };
    const lc = loginCid();
    if (lc) headers["login-customer-id"] = lc;
    const r = await fetch(`https://googleads.googleapis.com/${API_VERSION}/customers/${cid()}/googleAds:search`, {
      method: "POST", headers,
      body: JSON.stringify({ query: "SELECT customer.id FROM customer LIMIT 1" }),
    });
    if (r.ok) {
      return { ...base, tokenExchange: "ok", apiCall: "ok", diagnosis: "ok" };
    }
    const text = (await r.text()).slice(0, 600);
    let diagnosis = `api_error_${r.status}`;
    if (r.status === 401) diagnosis = "developer_token_or_auth_invalid";
    else if (r.status === 403 && /not.*approved|test|DEVELOPER_TOKEN_NOT_APPROVED|PROHIBITED/i.test(text)) diagnosis = "developer_token_not_approved_for_production";
    else if (r.status === 403) diagnosis = "forbidden_check_login_customer_id_or_access";
    else if (r.status === 404) diagnosis = "customer_id_not_found_or_not_linked";
    return { ...base, tokenExchange: "ok", apiCall: `status ${r.status}: ${text}`, diagnosis };
  } catch (e) {
    return { ...base, tokenExchange: "ok", apiCall: e instanceof Error ? e.message : String(e), diagnosis: "api_call_failed" };
  }
}
