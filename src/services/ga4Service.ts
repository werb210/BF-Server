import { safeImport } from "../utils/safeImport.js";
import { logError } from "../observability/logger.js";

// BF_SERVER_GA4_SERVICE_v1 — server-side GA4 (Analytics Data API) via a service-account key.
// Credentials are read at runtime from env, so the app boots fine before they are set.

export type Ga4Row = { dim: string; sessions: number; users: number };
export type Ga4Report = {
  configured: true;
  days: number;
  summary: { activeUsers: number; newUsers: number; sessions: number; pageViews: number; avgSessionSec: number };
  channels: Ga4Row[];
  sources: Ga4Row[];
  landingPages: Ga4Row[];
  countries: Ga4Row[];
  devices: Ga4Row[];
};

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
  } catch {
    logError("ga4_sa_json_parse_failed");
  }
  return null;
}

export async function runGa4Report(days: number): Promise<Ga4Report | null> {
  const creds = loadCreds();
  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!creds || !propertyId) return null;

  const mod: any = await safeImport("googleapis");
  const google: any = mod?.google ?? mod?.default?.google ?? mod;
  if (!google?.auth?.GoogleAuth || !google?.analyticsdata) {
    logError("googleapis_unavailable_for_ga4");
    return null;
  }

  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: creds.client_email, private_key: creds.private_key },
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  });
  const analyticsdata: any = google.analyticsdata({ version: "v1beta", auth });
  const property = `properties/${propertyId}`;
  const dateRanges = [{ startDate: `${days}daysAgo`, endDate: "today" }];

  async function report(dimensions: string[], metrics: string[], limit?: number): Promise<any[]> {
    const res = await analyticsdata.properties.runReport({
      property,
      requestBody: {
        dateRanges,
        dimensions: dimensions.map((name) => ({ name })),
        metrics: metrics.map((name) => ({ name })),
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

  const sumRows = await report([], ["activeUsers", "newUsers", "sessions", "screenPageViews", "averageSessionDuration"]);
  const sm: any[] = sumRows[0]?.metricValues ?? [];
  const num = (i: number) => Number(sm[i]?.value ?? 0);
  const summary = {
    activeUsers: num(0),
    newUsers: num(1),
    sessions: num(2),
    pageViews: num(3),
    avgSessionSec: Math.round(num(4)),
  };

  const [ch, src, lp, ctry, dev] = await Promise.all([
    report(["sessionDefaultChannelGroup"], ["sessions", "activeUsers"], 10),
    report(["sessionSourceMedium"], ["sessions", "activeUsers"], 10),
    report(["landingPage"], ["sessions", "activeUsers"], 10),
    report(["country"], ["sessions", "activeUsers"], 10),
    report(["deviceCategory"], ["sessions", "activeUsers"], 10),
  ]);

  return { configured: true, days, summary,
    channels: toRows(ch), sources: toRows(src), landingPages: toRows(lp), countries: toRows(ctry), devices: toRows(dev) };
}
