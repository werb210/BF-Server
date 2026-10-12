// BF_SERVER_WEEKLY_SUMMARY_v721 + BF_SERVER_REPORTS_BATCH3_v721
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), send: vi.fn(), adsEmail: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, dbQuery: h.query }));
vi.mock("../services/sendgridService.js", async () => ({
  ...(await vi.importActual<any>("../services/sendgridService.js")),
  sendgridConfigured: () => true,
  sendTransactional: h.send,
}));
vi.mock("../services/googleDataManager.js", () => ({ commissionRate: () => 0.02 }));
vi.mock("../services/reports/data.js", async () => ({
  ...(await vi.importActual<any>("../services/reports/data.js")),
  stuckDeals: async () => ({ items: [] }),
}));
vi.mock("../services/reports/data2.js", async () => ({
  ...(await vi.importActual<any>("../services/reports/data2.js")),
  missedCalls: async () => ({ not_called_back: 0 }),
}));
vi.mock("../services/adsWeeklyEmail.js", async () => ({
  ...(await vi.importActual<any>("../services/adsWeeklyEmail.js")),
  maybeSendWeeklyAdsEmail: h.adsEmail,
}));
vi.mock("../workers/claim.js", () => ({ claimedTick: (_name: string, fn: () => Promise<unknown>) => fn }));

import { maybeSendWeeklySummary, renderSummary } from "../services/weeklySummaryEmail.js";
import { weeklyRecipients } from "../services/adsWeeklyEmail.js";
import { catalogFor } from "../services/reports/catalog.js";

// Monday 2026-10-12, 09:00 in Edmonton (MDT, UTC-6).
const MONDAY_MORNING = new Date("2026-10-12T15:00:00Z");
const RECIPIENTS = "ops@example.com,lead@example.com";

function claims(rowCount: number) {
  h.query.mockImplementation(answerBySql([[/INSERT INTO weekly_summary_reports/, { rowCount, rows: rowCount ? [{ week_start: "2026-10-12" }] : [] }]]));
}

beforeEach(() => {
  vi.stubEnv("GOOGLE_HEALTH_ALERT_EMAILS", RECIPIENTS);
  h.query.mockReset();
  h.send.mockReset().mockResolvedValue({ ok: true, status: 202 });
  h.adsEmail.mockReset().mockResolvedValue({ sent: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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

  it("goes out once a week, to the Monday ads email's recipients", async () => {
    claims(1);
    expect(await maybeSendWeeklySummary(MONDAY_MORNING)).toEqual({ sent: true });
    expect(h.send.mock.calls.map((c) => c[0].to)).toEqual(weeklyRecipients());
    expect(weeklyRecipients()).toEqual(RECIPIENTS.split(","));
    const [claim] = callsMatching(h.query, /INSERT INTO weekly_summary_reports/);
    expect(String(claim[0])).toContain("ON CONFLICT (week_start) DO NOTHING");
    expect(claim[1]).toEqual(["2026-10-12", RECIPIENTS]);

    // The week is already claimed (another instance, or a later tick): nothing is sent.
    h.send.mockClear();
    claims(0);
    expect(await maybeSendWeeklySummary(MONDAY_MORNING)).toEqual({ sent: false, reason: "already_sent" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("only on Monday morning", async () => {
    claims(1);
    expect(await maybeSendWeeklySummary(new Date("2026-10-13T15:00:00Z"))).toEqual({ sent: false, reason: "not_monday_morning" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("the Monday ads worker sends the summary alongside the ads email", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(MONDAY_MORNING);
    claims(1);
    const kicks: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 90 * 1000) { kicks.push(fn); return realSetTimeout(() => undefined, 0); }
      return realSetTimeout(fn, ms);
    }) as any);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { startAdsWeeklyEmailWorker } = await import("../workers/adsWeeklyEmailWorker.js");
    const worker = startAdsWeeklyEmailWorker({} as any);
    try {
      expect(kicks).toHaveLength(1);
      kicks[0]();
      await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(RECIPIENTS.split(",").length));
      expect(h.adsEmail).toHaveBeenCalledTimes(1);
      expect(String(h.send.mock.calls[0][0].subject)).toContain("Boreal week in review");
    } finally {
      worker.stop();
      vi.useRealTimers();
    }
  });
});

describe("batch 3 reports", () => {
  it("best lender by deal type is for everyone; consent health is marketing", () => {
    expect(catalogFor("Staff").map((r) => r.key)).toContain("best_lender_by_deal_type");
    expect(catalogFor("Staff").map((r) => r.key)).not.toContain("consent_health");
    expect(catalogFor("Marketing").map((r) => r.key)).toContain("consent_health");
  });
});
