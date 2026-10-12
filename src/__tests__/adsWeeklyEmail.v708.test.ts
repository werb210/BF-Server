// BF_SERVER_ADS_WEEKLY_EMAIL_v708
import { describe, it, expect, afterEach, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { bootIndex } from "./helpers/bootIndex.js";

const query = vi.fn();
const sendTransactional = vi.fn(async (_m: unknown) => ({ ok: true, status: 202 }));
vi.mock("../db.js", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock("../services/adsPicture.js", () => ({ fullPictureInsights: async () => [] }));
vi.mock("../services/sendgridService.js", () => ({ sendgridConfigured: () => true, sendTransactional: (m: unknown) => sendTransactional(m) }));
import { maybeSendWeeklyAdsEmail, mondayWindow, renderWeeklyEmail, weeklyRecipients } from "../services/adsWeeklyEmail.js";

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

describe("Monday ads email", () => {
  it("only sends Monday morning Edmonton time", () => {
    expect(mondayWindow(new Date("2026-10-05T15:00:00Z"))).toBe("2026-10-05"); // Mon 09:00 MDT
    expect(mondayWindow(new Date("2026-10-05T12:00:00Z"))).toBeNull(); // Mon 06:00
    expect(mondayWindow(new Date("2026-10-06T15:00:00Z"))).toBeNull(); // Tuesday
  });
  it("goes to Todd and Andrew by default", () => {
    delete process.env.GOOGLE_HEALTH_ALERT_EMAILS;
    expect(weeklyRecipients()).toHaveLength(2);
  });
  it("tells the story and says nothing was changed", () => {
    const { subject, html } = renderWeeklyEmail({ spend: 1000, clicks: 50, people: 5, started: 4, submitted: 2, funded: 1, fundedAmount: 100000, campaigns: [{ name: "BF Search <CA>", spend: 600, clicks: 30 }], wasted: [], stops: [{ step: 1, stopped: 2 }], suggestions: ["Add negative"] }, 0.03);
    expect(subject).toContain("$1,000 spent");
    expect(html).toContain("return on ad spend 3.00x");
    expect(html).toContain("BF Search &lt;CA&gt;");
    expect(html).toContain("nothing has been changed in Google Ads");
  });
  it("is started at boot with the pool", async () => {
    const boot = await bootIndex();
    try {
      await boot.workersDone();
      expect(boot.workerCalls.get("startAdsWeeklyEmailWorker")).toEqual([[boot.pool]]);
    } finally { boot.restore(); }
  });
  it("sends once per week: the week is claimed with ON CONFLICT DO NOTHING and a second claim sends nothing", async () => {
    delete process.env.GOOGLE_HEALTH_ALERT_EMAILS;
    const claimed = new Set<string>();
    query.mockImplementation(answerBySql([
      [/INSERT INTO ads_weekly_reports/, (_sql: string, params?: unknown[]) => {
        const week = String(params?.[0]);
        if (claimed.has(week)) return { rows: [], rowCount: 0 };
        claimed.add(week);
        return { rows: [{ week_start: week }], rowCount: 1 };
      }],
    ]));
    const monday = new Date("2026-10-05T15:00:00Z");
    expect(await maybeSendWeeklyAdsEmail(monday)).toEqual({ sent: true });
    expect(sendTransactional).toHaveBeenCalledTimes(2);
    expect(await maybeSendWeeklyAdsEmail(monday)).toEqual({ sent: false, reason: "already_sent" });
    expect(sendTransactional).toHaveBeenCalledTimes(2);
    const claims = callsMatching(query, /INSERT INTO ads_weekly_reports/);
    expect(claims[0][0]).toContain("ON CONFLICT (week_start) DO NOTHING");
    expect(claims[0][1]).toEqual(["2026-10-05", expect.any(String)]);
  });
});
