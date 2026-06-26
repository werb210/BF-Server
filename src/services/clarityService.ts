import { logError } from "../observability/logger.js";

// BF_SERVER_CLARITY_SERVICE_v2 — Microsoft Clarity Data Export API, multi-project.
// Supports two projects (Website + Client app), each with its own token + cache.
// HARD CONSTRAINTS: only last 1-3 days; max 10 requests/project/day (each project has
// its own budget); heatmaps & recordings are NOT in the API (UI deep-links).

export type ClarityMetric = { metricName: string; rows: Record<string, any>[] };
export type ClarityProjectReport = {
  name: string;
  dashboardUrl: string | null;
  days: number;
  cached: boolean;
  error?: string;
  metrics: ClarityMetric[];
};
export type ClarityReport = { configured: true; days: number; projects: ClarityProjectReport[] };

type ProjectCfg = { name: string; token?: string; projectId?: string };

function projectConfigs(): ProjectCfg[] {
  return [
    { name: "Website", token: process.env.CLARITY_API_TOKEN, projectId: process.env.CLARITY_PROJECT_ID },
    { name: "Client app", token: process.env.CLARITY_API_TOKEN_CLIENT, projectId: process.env.CLARITY_PROJECT_ID_CLIENT },
  ].filter((p) => Boolean(p.token));
}

export function clarityConfigured(): boolean {
  return projectConfigs().length > 0;
}

function cacheMinutes(): number {
  const n = Number(process.env.CLARITY_CACHE_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 180;
}
function dashboardUrl(projectId?: string): string | null {
  return projectId ? `https://clarity.microsoft.com/projects/view/${projectId}/dashboard` : null;
}

const cache = new Map<string, { at: number; report: ClarityProjectReport }>();

async function fetchProject(cfg: ProjectCfg, days: number): Promise<ClarityProjectReport> {
  const key = `${cfg.name}:${days}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < cacheMinutes() * 60_000) {
    return { ...cached.report, cached: true };
  }
  const base: ClarityProjectReport = { name: cfg.name, dashboardUrl: dashboardUrl(cfg.projectId), days, cached: false, metrics: [] };
  try {
    const url = `https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=${days}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    });
    if (resp.status === 429) {
      if (cached) return { ...cached.report, cached: true };
      return { ...base, error: "Clarity daily pull limit reached (10/day). Try later." };
    }
    if (!resp.ok) {
      if (cached) return { ...cached.report, cached: true };
      return { ...base, error: `Clarity returned HTTP ${resp.status}.` };
    }
    const json: any = await resp.json();
    const arr: any[] = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
    const metrics: ClarityMetric[] = arr.map((m) => ({
      metricName: String(m?.metricName ?? "Metric"),
      rows: Array.isArray(m?.information) ? m.information : [],
    }));
    const report: ClarityProjectReport = { ...base, metrics };
    cache.set(key, { at: Date.now(), report });
    return report;
  } catch {
    logError("clarity_fetch_failed");
    if (cached) return { ...cached.report, cached: true };
    return { ...base, error: "Clarity request failed." };
  }
}

export async function runClarityReport(daysIn: number): Promise<ClarityReport | null> {
  const cfgs = projectConfigs();
  if (cfgs.length === 0) return null;
  const days = Math.min(Math.max(daysIn || 3, 1), 3);
  const projects = await Promise.all(cfgs.map((c) => fetchProject(c, days)));
  return { configured: true, days, projects };
}
