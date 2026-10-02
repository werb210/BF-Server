// BF_SERVER_MAYA_ADS_TOOLS_v712 - Maya's staff tools for the Ads reports the
// portal shows: Story, Visitors, Drop-off, Health, Website (GA4) and Audiences.
// Read-only. Every answer carries Boreal's ad rules so Maya's advice follows them.
import { Router, type Request, type Response } from "express";
import { safeHandler } from "../middleware/safeHandler.js";
import { logError } from "../observability/logger.js";
import { verifyMayaService, audit } from "./mayaStaff.js";
import { storyReport, visitorsReport, dropoffReport, windowDays, storyBy } from "./marketing/adsStory.js";
import { ADS_RULES } from "../services/adsRules.js";

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const router = Router();

function route(path: string, tool: string, run: (req: Request) => Promise<any>) {
  router.post(path, safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) return res.status(401).json({ ok: false, error: "service_jwt_required" });
    const args = { ...(req.body ?? {}) };
    try {
      const out = await run(req);
      await audit({ audience: "staff", tool, args, ok: true, summary: String(out?.summary ?? ""), sessionId: str(req.body?.session_id) });
      return res.json({ ok: true, ad_rules: ADS_RULES, ...out });
    } catch (e: any) {
      await audit({ audience: "staff", tool, args, ok: false, summary: e?.message ?? "error", errorCode: tool.replace(/[^a-z]/gi, "_") + "_exception" });
      logError("maya_ads_insight_failed", { tool, error: e?.message ?? "unknown" });
      return res.status(502).json({ ok: false, error: "report_failed", message: e?.message ?? "unknown" });
    }
  }));
}

route("/staff/ads-story", "ads.story", async (req) => {
  const r = await storyReport(windowDays(req.body?.days), storyBy(req.body?.by));
  const t = r.totals;
  return { ...r, summary: `Last ${r.days} days: spend $${Math.round(t.spend)}, ${t.clicks} clicks, ${t.people} people in the CRM, ${t.started} started, ${t.submitted} submitted, ${t.qualified} qualified, ${t.funded} funded, commission $${Math.round(t.commission)}${t.roas !== null ? `, return on ad spend ${t.roas}x` : ""}.` };
});

route("/staff/ads-visitors", "ads.visitors", async (req) => {
  const filter = ["all", "ad", "identified", "abandoned", "submitted"].includes(String(req.body?.filter)) ? String(req.body.filter) : "all";
  const r = await visitorsReport(windowDays(req.body?.days, 30), filter);
  const rows = r.visitors as any[];
  const fromAd = rows.filter((v) => v.from_ad).length;
  const withApp = rows.filter((v) => v.application_id).length;
  const submitted = rows.filter((v) => v.submitted_at).length;
  return { days: r.days, filter, visitors: rows.slice(0, 50), shown: Math.min(rows.length, 50), total: rows.length,
    summary: `${rows.length} visitor session(s) in the last ${r.days} days (${filter}): ${fromAd} from ads, ${withApp} started an application, ${submitted} submitted.` };
});

route("/staff/ads-dropoff", "ads.dropoff", async (req) => {
  const r = await dropoffReport(windowDays(req.body?.days));
  const worst = [...(r.steps as any[])].sort((a, b) => b.stopped - a.stopped)[0];
  return { ...r, summary: `Last ${r.days} days: ${r.totals.started} started, ${r.totals.submitted} submitted.${worst ? ` Most unfinished applications stopped at Step ${worst.step} (${worst.stopped}).` : ""}` };
});

route("/staff/ads-health", "ads.health", async () => {
  const h: any = await (await import("../services/googleHealth.js")).getGoogleHealth(false);
  const checks = Array.isArray(h?.checks) ? h.checks : [];
  const failing = checks.filter((c: any) => c.status === "fail");
  return { ...h, summary: failing.length ? `${failing.length} Google connection check(s) failing: ${failing.map((c: any) => c.label).join(", ")}.` : "All Google connection checks pass." };
});

route("/staff/ga4", "ads.ga4", async (req) => {
  const { ga4Configured, runGa4Report } = await import("../services/ga4Service.js");
  if (!ga4Configured()) return { configured: false, summary: "Google Analytics is not set up on the server." };
  const days = Math.min(Math.max(Number(req.body?.days) || 30, 1), 365);
  const report: any = await runGa4Report(days);
  return { configured: true, days, report, summary: report ? `Google Analytics report for the last ${days} days.` : "Google Analytics returned no data." };
});

route("/staff/ads-audiences", "ads.audiences", async () => {
  const { listStatus, customerMatchConfigured, listApplicants } = await import("../services/customerMatchLists.js");
  const lists = await listStatus();
  const { rows } = await listApplicants();
  const unsent = rows.filter((r) => !r.sent_at).length;
  return { configured: customerMatchConfigured(), lists, applicants_not_sent: unsent,
    summary: `${lists.map((l) => `${l.name}: ${l.listId ? `${l.members} sent` : "not created yet"}`).join("; ")}. ${unsent} applicant(s) not yet sent - staff send them from Marketing > Ads > Google > Audiences.` };
});

export default router;
