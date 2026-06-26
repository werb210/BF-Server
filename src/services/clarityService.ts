import { logError } from "../observability/logger.js";

// BF_SERVER_CLARITY_SERVICE_v1 — Microsoft Clarity Data Export API.
// Endpoint: GET https://www.clarity.ms/export-data/api/v1/project-live-insights
// Auth: Bearer token (Clarity -> Settings -> Data Export -> Generate API token).
// HARD CONSTRAINTS (designed around, not bugs):
//   * Only the last 1-3 days are available (numOfDays in {1,2,3}); no long history.
//   * Max 10 requests/project/day -> we make ONE request per refresh and cache it.
//   * Heatmaps & session replays are NOT in the API -> UI deep-links to the dashboard.

export type ClarityMetric = { metricName: string; rows: Record<string, any>[] };
export type ClarityReport = {
  configured: true;
  days: number;
  generatedAt: string;
  cached: boolean;
  dashboardUrl: string | null;
  metrics: ClarityMetric[];
};

export function clarityConfigured(): boolean {
  return Boolean(process.env.CLARITY_API_TOKEN);
}

let cache: { at: number; days: number; report: ClarityReport } | null = null;

function cacheMinutes(): number {
  const n = Number(process.env.CLARITY_CACHE_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 180;
}

function dashboardUrl(): string | null {
  const pid = process.env.CLARITY_PROJECT_ID;
  return pid ? `https://clarity.microsoft.com/projects/view/${pid}/dashboard` : null;
}

export async function runClarityReport(daysIn: number): Promise<ClarityReport | null> {
  const token = process.env.CLARITY_API_TOKEN;
  if (!token) return null;
  const days = Math.min(Math.max(daysIn || 3, 1), 3);

  if (cache && cache.days === days && Date.now() - cache.at < cacheMinutes() * 60_000) {
    return { ...cache.report, cached: true };
  }

  try {
    const url = `https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=${days}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (resp.status === 429) {
      logError("clarity_rate_limited");
      if (cache) return { ...cache.report, cached: true };
      return null;
    }
    if (!resp.ok) {
      logError("clarity_http_error");
      if (cache) return { ...cache.report, cached: true };
      return null;
    }
    const json: any = await resp.json();
    const arr: any[] = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
    const metrics: ClarityMetric[] = arr.map((m) => ({
      metricName: String(m?.metricName ?? "Metric"),
      rows: Array.isArray(m?.information) ? m.information : [],
    }));
    const report: ClarityReport = {
      configured: true,
      days,
      generatedAt: new Date().toISOString(),
      cached: false,
      dashboardUrl: dashboardUrl(),
      metrics,
    };
    cache = { at: Date.now(), days, report };
    return report;
  } catch {
    logError("clarity_fetch_failed");
    if (cache) return { ...cache.report, cached: true };
    return null;
  }
}
