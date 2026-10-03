// BF_SERVER_WEEKLY_SUMMARY_v721 + BF_SERVER_REPORTS_BATCH3_v721
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderSummary } from "../services/weeklySummaryEmail.js";
import { catalogFor } from "../services/reports/catalog.js";

describe("Monday week-in-review email", () => {
  const d = { submitted: 4, funded: 1, fundedAmount: 200000, pipeline: [{ stage: "Off to Lender", files: 3 }], stuck: [{ name: "Acme <Ltd>", stage: "In Review", days_in_stage: 12 }], missedNotReturned: 2, splitsWaiting: 1, feeAgreementsWaiting: 0 };
  it("covers the week, the pipeline and what is stuck or waiting", () => {
    const { subject, html } = renderSummary(d, 0.03);
    expect(subject).toBe("Boreal week in review: 4 submitted, 1 funded");
    expect(html).toContain("about $6,000 commission");
    expect(html).toContain("Off to Lender");
    expect(html).toContain("In Review, 12 days");
    expect(html).toContain("Missed calls nobody returned");
  });
  it("escapes names", () => {
    expect(renderSummary(d, 0.03).html).toContain("Acme &lt;Ltd&gt;");
  });
  it("goes out once a week with the Monday ads email, to the same people", () => {
    const src = readFileSync("src/services/weeklySummaryEmail.ts", "utf8");
    expect(src).toContain("ON CONFLICT (week_start) DO NOTHING");
    expect(src).toContain("weeklyRecipients()");
    expect(readFileSync("src/workers/adsWeeklyEmailWorker.ts", "utf8")).toContain("maybeSendWeeklySummary()");
  });
});

describe("batch 3 reports", () => {
  it("best lender by deal type is for everyone; consent health is marketing", () => {
    expect(catalogFor("Staff").map((r) => r.key)).toContain("best_lender_by_deal_type");
    expect(catalogFor("Staff").map((r) => r.key)).not.toContain("consent_health");
    expect(catalogFor("Marketing").map((r) => r.key)).toContain("consent_health");
  });
});
