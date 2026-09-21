import { safeImport } from "../utils/safeImport.js";
import { logError } from "../observability/logger.js";

// BF_SERVER_GA4_SERVICE_v2 — server-side GA4 (Analytics Data API) via a service-account key.
export type Ga4Row = { dim: string; sessions: number; users: number };
export type Ga4Trend = { date: string; sessions: number };
export type Ga4Report = {
  configured: true;
  days: number;
  cached: boolean;
  summary: {
    activeUsers: number; newUsers: number; sessions: number; pageViews: number;
    avgSessionSec: number; engagementRate: number; engagedSessions: number;
  };
  channels: Ga4Row[]; sources: Ga4Row[]; campaigns: Ga4Row[]; adContent: Ga4Row[];
  events: Ga4Row[]; landingPages: Ga4Row[]; topPages: Ga4Row[]; newVsReturning: Ga4Row[];
  countries: Ga4Row[]; cities: Ga4Row[]; browsers: Ga4Row[]; operatingSystems: Ga4Row[];
  devices: Ga4Row[]; trend: Ga4Trend[];
  /** BF_SERVER_GA4_QUOTA_v386 - true when GA4 refused a refresh and these are the last good figures. */
  stale?: boolean;
};
export type Ga4Error = { configured: true; days: number; error: string };

export function ga4Configured(): boolean {
  return Boolean(process.env.GA4_SA_JSON && process.env.GA4_PROPERTY_ID);
}

function loadCreds(): { client_email: string; private_key: string } | null {
  const raw = process.env.GA4_SA_JSON;
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (j.client_email && j.private_key) {
      return { client_email: String(j.client_email), private_key: String(j.private_key).replace(/\\n/g, "\n") };
    }
  } catch { logError("ga4_sa_json_parse_failed"); }
  return null;
}

function prettyPath(p: string): string {
  if (!p || p === "(not set)") return "(not set)";
  const path = p.split("?")[0].replace(/\/+$/, "") || "/";
  if (path === "/") return "Homepage";
  const stepM = path.match(/^\/apply\/step-(\w+)/i);
  if (stepM) return `Apply · Step ${stepM[1]}`;
  if (/^\/application\//i.test(path)) return "Application page";
  if (/^\/apply\b/i.test(path)) return "Apply";
  if (/^\/sign|signing/i.test(path)) return "Signing";
  if (/^\/login|auth/i.test(path)) return "Login";
  return path;
}
function collapse(rows: Ga4Row[], topN = 10): Ga4Row[] {
  const m = new Map<string, Ga4Row>();
  for (const r of rows) {
    const dim = prettyPath(r.dim);
    const cur = m.get(dim);
    if (cur) { cur.sessions += r.sessions; cur.users += r.users; }
    else m.set(dim, { dim, sessions: r.sessions, users: r.users });
  }
  return Array.from(m.values()).sort((a, b) => b.sessions - a.sessions).slice(0, topN);
}

// BF_SERVER_GA4_QUOTA_v386 - the dashboard showed a GA4 quota error because:
//  * one report fired 14 runReport calls at once; the GA4 Data API allows 10
//    concurrent requests per property, so every uncached load broke the limit;
//  * the cache held ONE date range, so switching 7d/30d/90d/365d evicted it;
//  * the dashboard's two panels asked at the same moment, doubling the burst;
//  * a failure was not remembered, so every refresh retried straight away.
// Now: one cached report per date range (30 min), one request in flight per
// range, at most 4 GA4 calls at a time, and after a failure the last good
// figures are served (marked stale) while GA4 is left alone for a while.
const cache = new Map<string, { at: number; report: Ga4Report }>();
const inflight = new Map<string, Promise<Ga4Report | Ga4Error>>();
const failures = new Map<string, { at: number; error: Ga4Error; backoffMs: number }>();
const MAX_CONCURRENT_REPORTS = 4;
const QUOTA_BACKOFF_MS = 10 * 60_000;
const ERROR_BACKOFF_MS = 2 * 60_000;
function cacheMinutes(): number {
  const n = Number(process.env.GA4_CACHE_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 30;
}
export function isGa4QuotaError(message: string): boolean {
  return /quota|exhausted|rate.?limit|too many requests|\b429\b/i.test(message);
}
async function inBatches<T>(tasks: Array<() => Promise<T>>, size: number): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < tasks.length; i += size) {
    out.push(...(await Promise.all(tasks.slice(i, i + size).map((task) => task()))));
  }
  return out;
}
/** Test hooks. */
let googleForTests: unknown = null;
export function __setGa4GoogleForTests(google: unknown): void {
  googleForTests = google;
}
export function __resetGa4StateForTests(): void {
  cache.clear();
  inflight.clear();
  failures.clear();
}

export async function runGa4Report(days: number): Promise<Ga4Report | Ga4Error | null> {
  const creds = loadCreds();
  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!creds) return { configured: true, days, error: "GA4_SA_JSON is missing or is not valid service-account JSON (it must contain client_email and private_key)." };
  if (!propertyId) return { configured: true, days, error: "GA4_PROPERTY_ID is not set." };

  const key = `${propertyId}:${days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < cacheMinutes() * 60_000) {
    return { ...hit.report, cached: true };
  }
  const failed = failures.get(key);
  if (failed && Date.now() - failed.at < failed.backoffMs) {
    return hit ? { ...hit.report, cached: true, stale: true } : failed.error;
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const run = (async (): Promise<Ga4Report | Ga4Error> => {
  try {
    const mod: any = googleForTests ?? (await safeImport("googleapis"));
    const google: any = mod?.google ?? mod?.default?.google ?? mod;
    if (!google?.auth?.GoogleAuth || !google?.analyticsdata) {
      return { configured: true, days, error: "googleapis library is unavailable on the server." };
    }
    const auth = new google.auth.GoogleAuth({
      credentials: { client_email: creds.client_email, private_key: creds.private_key },
      scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
    });
    const analyticsdata: any = google.analyticsdata({ version: "v1beta", auth });
    const property = `properties/${propertyId}`;
    const dateRanges = [{ startDate: `${days}daysAgo`, endDate: "today" }];

    async function report(dimensions: string[], metrics: string[], limit?: number, orderByMetric?: string): Promise<any[]> {
      const res = await analyticsdata.properties.runReport({
        property,
        requestBody: {
          dateRanges,
          dimensions: dimensions.map((name) => ({ name })),
          metrics: metrics.map((name) => ({ name })),
          ...(orderByMetric ? { orderBys: [{ metric: { metricName: orderByMetric }, desc: true }] } : {}),
          ...(limit ? { limit: String(limit) } : {}),
        },
      });
      return res?.data?.rows ?? [];
    }
    const toRows = (rows: any[]): Ga4Row[] =>
      rows.map((r) => ({
        dim: String(r?.dimensionValues?.[0]?.value ?? "(not set)"),
        sessions: Number(r?.metricValues?.[0]?.value ?? 0),
        users: Number(r?.metricValues?.[1]?.value ?? 0),
      }));

    const sumRows = await report([], ["activeUsers", "newUsers", "sessions", "screenPageViews", "averageSessionDuration", "engagementRate", "engagedSessions"]);
    const sm: any[] = sumRows[0]?.metricValues ?? [];
    const num = (i: number) => Number(sm[i]?.value ?? 0);
    const summary = {
      activeUsers: num(0), newUsers: num(1), sessions: num(2), pageViews: num(3),
      avgSessionSec: Math.round(num(4)), engagementRate: Math.round(num(5) * 1000) / 10, engagedSessions: num(6),
    };

    // BF_SERVER_GA4_QUOTA_v386 - at most MAX_CONCURRENT_REPORTS in flight (GA4 allows 10 per property).
    const [ch, src, camp, adc, ev, lp, pg, nvr, ctry, city, br, os, dev, tr] = await inBatches([
      () => report(["sessionDefaultChannelGroup"], ["sessions", "activeUsers"], 10, "sessions"),
      () => report(["sessionSourceMedium"], ["sessions", "activeUsers"], 10, "sessions"),
      () => report(["sessionCampaignName"], ["sessions", "activeUsers"], 10, "sessions"),
      () => report(["sessionManualAdContent"], ["sessions", "activeUsers"], 10, "sessions"),
      () => report(["eventName"], ["eventCount", "totalUsers"], 15, "eventCount"),
      () => report(["landingPage"], ["sessions", "activeUsers"], 50, "sessions"),
      () => report(["pagePath"], ["screenPageViews", "totalUsers"], 50, "screenPageViews"),
      () => report(["newVsReturning"], ["sessions", "activeUsers"], 5, "sessions"),
      () => report(["country"], ["sessions", "activeUsers"], 10, "sessions"),
      () => report(["city"], ["sessions", "activeUsers"], 10, "sessions"),
      () => report(["browser"], ["sessions", "activeUsers"], 8, "sessions"),
      () => report(["operatingSystem"], ["sessions", "activeUsers"], 8, "sessions"),
      () => report(["deviceCategory"], ["sessions", "activeUsers"], 5, "sessions"),
      () => report(["date"], ["sessions"]),
    ], MAX_CONCURRENT_REPORTS);

    const trend: Ga4Trend[] = toRows(tr)
      .map((r) => ({ date: r.dim, sessions: r.sessions }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => ({ date: /^\d{8}$/.test(r.date) ? `${r.date.slice(0,4)}-${r.date.slice(4,6)}-${r.date.slice(6,8)}` : r.date, sessions: r.sessions }));

    const report_: Ga4Report = {
      configured: true, days, cached: false, summary,
      channels: toRows(ch), sources: toRows(src), campaigns: toRows(camp), adContent: toRows(adc),
      events: toRows(ev), landingPages: collapse(toRows(lp), 10), topPages: collapse(toRows(pg), 10),
      newVsReturning: toRows(nvr), countries: toRows(ctry), cities: toRows(city),
      browsers: toRows(br), operatingSystems: toRows(os), devices: toRows(dev), trend,
    };
    cache.set(key, { at: Date.now(), report: report_ });
    failures.delete(key);
    return report_;
  } catch (e: any) {
    const msg = e?.response?.data?.error?.message || e?.errors?.[0]?.message || e?.message || String(e);
    logError("ga4_report_failed: " + msg);
    const quota = isGa4QuotaError(String(msg));
    const error: Ga4Error = {
      configured: true,
      days,
      error: quota
        ? "Google Analytics is over its request limit right now; it will refresh automatically in a few minutes."
        : String(msg).slice(0, 400),
    };
    failures.set(key, { at: Date.now(), error, backoffMs: quota ? QUOTA_BACKOFF_MS : ERROR_BACKOFF_MS });
    const last = cache.get(key);
    return last ? { ...last.report, cached: true, stale: true } : error;
  }
  })().finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}
