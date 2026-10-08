// BF_SERVER_REPORTS_SECTION_v714 - report catalog and role access rules.
export type ReportGroup = "money" | "marketing" | "operations";
export type ReportDef = { key: string; title: string; silo: "BF" | "BI" | "SLF"; group: ReportGroup; size: "half" | "full"; source: string; description: string };

export const REPORTS: ReportDef[] = [
  // BF_SERVER_DASHBOARD_BOARD_v730 - the standard Dashboard sections, as cards a person can
  // move, resize, remove and add back. Drawn by the portal; only offered on the Dashboard.
  { key: "dash_kpis", title: "Key numbers", silo: "BF", group: "operations", size: "full", source: "dashboard", description: "Active applications, deals won, commission earned, new contacts." },
  { key: "dash_pipeline", title: "Pipeline by stage", silo: "BF", group: "operations", size: "full", source: "dashboard", description: "Open files by stage with projected commission." },
  { key: "dash_totals", title: "Visits to funded", silo: "BF", group: "operations", size: "full", source: "dashboard", description: "Website visits, applications, submitted and funded." },
  { key: "dash_dropoffs", title: "Application funnel and drop-offs", silo: "BF", group: "operations", size: "full", source: "dashboard", description: "Recent applications by current stage." },
  { key: "dash_acquisition", title: "Acquisition channels", silo: "BF", group: "operations", size: "half", source: "dashboard", description: "Where applications came from." },
  { key: "dash_marketing_perf", title: "Marketing performance", silo: "BF", group: "operations", size: "half", source: "dashboard", description: "Revenue by marketing channel." },
  { key: "dash_funding_product", title: "Funding by product", silo: "BF", group: "operations", size: "half", source: "dashboard", description: "Funded deals by product." },
  { key: "dash_doc_issues", title: "Document upload issues", silo: "BF", group: "operations", size: "half", source: "dashboard", description: "Document types with upload problems." },
  { key: "dash_top_lenders", title: "Top lenders by approval rate", silo: "BF", group: "operations", size: "half", source: "dashboard", description: "Lenders approving the most files." },
  // BF_SERVER_DASH_TEAM_CARD_v774 - BF-portal v758 card. Not in this list, cleanCards() dropped it on every save, so it vanished after leaving the Dashboard.
  { key: "dash_team", title: "New team messages", silo: "BF", group: "operations", size: "full", source: "dashboard", description: "Team conversations with unread messages; click one to open it." },
  { key: "stuck_deals", title: "Stuck deals", silo: "BF", group: "operations", size: "full", source: "reports", description: "Open files and how many days each has sat in its current stage." },
  { key: "lender_scorecard", title: "Lender scorecard", silo: "BF", group: "operations", size: "full", source: "reports", description: "Files sent, offers, funded and days to an offer, per lender." },
  { key: "speed_to_lead", title: "Speed to lead", silo: "BF", group: "operations", size: "half", source: "reports", description: "Time from a submitted application to the first call, per staff member." },
  // BF_SERVER_REPORTS_BATCH5_v776
  { key: "deal_velocity", title: "Deal velocity", silo: "BF", group: "operations", size: "full", source: "reports", description: "Median days from start to submitted, to first offer and to funded, by product." },
  { key: "win_rate", title: "Won vs lost", silo: "BF", group: "operations", size: "full", source: "reports", description: "Submitted files that funded, were lost or are still open - by month and product." },
  { key: "call_outcomes", title: "Call outcomes", silo: "BF", group: "operations", size: "half", source: "reports", description: "Outbound calls by result, per person (staff see their own)." },
  { key: "client_reply_time", title: "Client reply time", silo: "BF", group: "operations", size: "full", source: "reports", description: "How fast staff answer clients, and who is waiting for a reply right now." },
  { key: "commission_receivable", title: "Commission receivable", silo: "BF", group: "money", size: "full", source: "reports", description: "Commission lenders owe Boreal on funded files, by age; mark it received." },
  // BF_SERVER_REPORTS6_10_v780
  { key: "pipeline_movement", title: "Pipeline movement", silo: "BF", group: "operations", size: "full", source: "reports", description: "Files started, submitted, funded and lost in the period, with amounts." },
  { key: "average_deal_size", title: "Average deal size", silo: "BF", group: "operations", size: "full", source: "reports", description: "Average and median requested amount by product and lead source, and for funded files." },
  { key: "goals", title: "Goals", silo: "BF", group: "money", size: "full", source: "reports", description: "This month's funding and commission targets per person, with progress." },
  { key: "meetings", title: "Meetings", silo: "BF", group: "operations", size: "full", source: "reports", description: "Client bookings per person: booked, held, cancelled, upcoming, and how many led to a funded file." },
  { key: "tasks_report", title: "Tasks", silo: "BF", group: "operations", size: "full", source: "reports", description: "Open, overdue and completed tasks per person, and how many were done on time." },
  // BF_SERVER_REPORTS11_14_v785
  { key: "email_performance", title: "Email performance", silo: "BF", group: "marketing", size: "full", source: "reports", description: "Staff, sequence and template emails: sent, opened and clicked." },
  { key: "sms_campaign_performance", title: "SMS campaign performance", silo: "BF", group: "marketing", size: "full", source: "reports", description: "Texts sent, delivered, failed, clicked, replies and opt-outs per campaign and sequence." },
  { key: "website_pages", title: "Website pages and devices", silo: "BF", group: "marketing", size: "full", source: "reports", description: "Landing pages that lead to applications, and visits by phone, tablet or computer." },
  { key: "lifecycle", title: "Lifecycle", silo: "BF", group: "operations", size: "full", source: "reports", description: "Leads to applicants to submitted to funded to repeat clients, with median days between steps." },
  { key: "commission_by_month", title: "Commission by month", silo: "BF", group: "money", size: "half", source: "reports", description: "Funded amount and estimated commission per month." },
  // BF_SERVER_REPORTS_BATCH4_v722
  { key: "decline_reasons", title: "Decline reasons", silo: "BF", group: "operations", size: "full", source: "reports", description: "Why lenders pass and files are rejected, from the reasons staff record." },
  { key: "document_turnaround", title: "Document turnaround", silo: "BF", group: "operations", size: "full", source: "reports", description: "How long clients take to send each required document, and what is still outstanding." },
  // BF_SERVER_REPORTS_BATCH3_v721
  { key: "best_lender_by_deal_type", title: "Best lender by deal type", silo: "BF", group: "operations", size: "full", source: "reports", description: "Which lender funds each kind of deal most often." },
  { key: "consent_health", title: "Consent health", silo: "BF", group: "marketing", size: "half", source: "reports", description: "Who can be texted, who opted out, and texting consent expiring in the next 30 days." },
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
