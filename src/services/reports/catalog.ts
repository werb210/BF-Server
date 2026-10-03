// BF_SERVER_REPORTS_SECTION_v714 - report catalog and role access rules.
export type ReportGroup = "money" | "marketing" | "operations";
export type ReportDef = { key: string; title: string; silo: "BF" | "BI" | "SLF"; group: ReportGroup; size: "half" | "full"; source: string; description: string };

export const REPORTS: ReportDef[] = [
  { key: "stuck_deals", title: "Stuck deals", silo: "BF", group: "operations", size: "full", source: "reports", description: "Open files and how many days each has sat in its current stage." },
  { key: "lender_scorecard", title: "Lender scorecard", silo: "BF", group: "operations", size: "full", source: "reports", description: "Files sent, offers, funded and days to an offer, per lender." },
  { key: "speed_to_lead", title: "Speed to lead", silo: "BF", group: "operations", size: "half", source: "reports", description: "Time from a submitted application to the first call, per staff member." },
  { key: "commission_by_month", title: "Commission by month", silo: "BF", group: "money", size: "half", source: "reports", description: "Funded amount and estimated commission per month." },
  // BF_SERVER_REPORTS_BATCH2_v719
  { key: "revenue_forecast", title: "Revenue forecast", silo: "BF", group: "money", size: "half", source: "reports", description: "Open files weighted by the chance each stage funds - expected commission." },
  { key: "media_fee_agreements", title: "Media fee agreements", silo: "BF", group: "money", size: "full", source: "reports", description: "Waiting and signed agreements, and the 2% fee each one carries." },
  { key: "payouts_owed", title: "Broker payouts", silo: "BF", group: "money", size: "full", source: "reports", description: "Funded broker files and whether the broker has been paid." },
  { key: "staff_activity", title: "Staff activity", silo: "BF", group: "operations", size: "half", source: "reports", description: "Calls, connections and talk time per person (staff see their own)." },
  { key: "missed_calls", title: "Missed calls", silo: "BF", group: "operations", size: "full", source: "reports", description: "Missed incoming calls and how long until someone called back." },
  { key: "monthly_cohorts", title: "Monthly cohorts", silo: "BF", group: "marketing", size: "half", source: "reports", description: "Applications started each month and how many submitted and funded." },
  { key: "renewal_opportunities", title: "Renewal opportunities", silo: "BF", group: "operations", size: "full", source: "reports", description: "Clients funded about a year ago - a call list for repeat business." },
  { key: "insurance_cross_sell", title: "Insurance cross-sell", silo: "BF", group: "operations", size: "half", source: "reports", description: "Funded Financial deals that also have a Boreal Insurance application." },
  // Cards that show the existing portal panels. The v714 catalog listed keys the
  // portal board cannot draw; these four are the ones it renders.
  { key: "ads_story", title: "Ads: the story", silo: "BF", group: "marketing", size: "full", source: "portal", description: "Ad spend to applications, funded deals and return." },
  { key: "ads_dropoff", title: "Where applications stop", silo: "BF", group: "marketing", size: "full", source: "portal", description: "The step unfinished applications stopped at, and why." },
  { key: "ads_visitors", title: "Website visitors", silo: "BF", group: "marketing", size: "full", source: "portal", description: "Who came, from where, and what they did." },
  { key: "bi_dashboard", title: "Insurance pipeline", silo: "BI", group: "operations", size: "full", source: "portal", description: "Boreal Insurance open pipeline and what needs attention." },
  { key: "ads_story", title: "Ads: the story", silo: "BF", group: "marketing", size: "full", source: "marketing", description: "Ad spend to applications, funded deals and return." },
  { key: "ads_dropoff", title: "Where applications stop", silo: "BF", group: "marketing", size: "half", source: "marketing", description: "The step unfinished applications stopped at." },
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
