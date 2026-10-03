// BF_SERVER_REPORTS_SECTION_v714 - report catalog and role access rules.
export type ReportGroup = "money" | "marketing" | "operations";
export type ReportDef = { key: string; title: string; silo: "BF" | "BI" | "SLF"; group: ReportGroup; size: "half" | "full"; source: string; description: string };

export const REPORTS: ReportDef[] = [
  { key: "stuck_deals", title: "Stuck deals", silo: "BF", group: "operations", size: "full", source: "reports", description: "Open files and how many days each has sat in its current stage." },
  { key: "lender_scorecard", title: "Lender scorecard", silo: "BF", group: "operations", size: "full", source: "reports", description: "Files sent, offers, funded and days to an offer, per lender." },
  { key: "speed_to_lead", title: "Speed to lead", silo: "BF", group: "operations", size: "half", source: "reports", description: "Time from a submitted application to the first call, per staff member." },
  { key: "commission_by_month", title: "Commission by month", silo: "BF", group: "money", size: "half", source: "reports", description: "Funded amount and estimated commission per month." },
  { key: "pipeline_by_stage", title: "Pipeline by stage", silo: "BF", group: "operations", size: "full", source: "dashboard", description: "Open files by stage (projected commission shown to Admins only)." },
  { key: "application_funnel", title: "Application funnel", silo: "BF", group: "operations", size: "half", source: "dashboard", description: "Applications by wizard step." },
  { key: "ads_story", title: "Ads: the story", silo: "BF", group: "marketing", size: "full", source: "marketing", description: "Ad spend to applications, funded deals and return." },
  { key: "ads_dropoff", title: "Where applications stop", silo: "BF", group: "marketing", size: "half", source: "marketing", description: "The step unfinished applications stopped at." },
  { key: "link_clicks", title: "Link clicks", silo: "BF", group: "marketing", size: "half", source: "marketing", description: "Clicks on tracked links in emails and texts." },
  { key: "template_performance", title: "Email and text templates", silo: "BF", group: "marketing", size: "full", source: "marketing", description: "Sends, opens, clicks and replies per template." },
  { key: "bi_pipeline", title: "Insurance pipeline", silo: "BI", group: "operations", size: "full", source: "bi", description: "Boreal Insurance applications by stage." },
];

export function normalizeRole(role: unknown): "Admin" | "Marketing" | "Staff" {
  const r = String(role ?? "").toLowerCase();
  if (r === "admin") return "Admin";
  if (r === "marketing") return "Marketing";
  return "Staff";
}
export function canSee(role: unknown, group: ReportGroup): boolean {
  const r = normalizeRole(role);
  if (r === "Admin") return true;
  if (r === "Marketing") return group !== "money";
  return group === "operations";
}
export function catalogFor(role: unknown): ReportDef[] { return REPORTS.filter((r) => canSee(role, r.group)); }
export function reportByKey(key: string): ReportDef | undefined { return REPORTS.find((r) => r.key === key); }
