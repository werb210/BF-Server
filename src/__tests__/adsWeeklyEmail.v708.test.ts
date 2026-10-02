// BF_SERVER_ADS_WEEKLY_EMAIL_v708
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { mondayWindow, renderWeeklyEmail, weeklyRecipients } from "../services/adsWeeklyEmail.js";

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
  it("is started at boot and sends once per week", () => {
    expect(readFileSync("src/index.ts", "utf8")).toContain("startAdsWeeklyEmailWorker(pool)");
    expect(readFileSync("src/services/adsWeeklyEmail.ts", "utf8")).toContain("ON CONFLICT (week_start) DO NOTHING");
  });
});
