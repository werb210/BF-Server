// BF_SERVER_WEEKLY_EMAILS_PAUSED_v1
import { afterEach, describe, expect, it, vi } from "vitest";

const { ads, summary } = vi.hoisted(() => ({ ads: vi.fn(async () => ({ sent: true })), summary: vi.fn(async () => ({ sent: true })) }));
vi.mock("../../services/adsWeeklyEmail.js", () => ({ maybeSendWeeklyAdsEmail: ads }));
vi.mock("../../services/weeklySummaryEmail.js", () => ({ maybeSendWeeklySummary: summary }));
vi.mock("../claim.js", () => ({ claimedTick: (_n: string, fn: () => Promise<void>) => fn }));

import { startAdsWeeklyEmailWorker, weeklyEmailsOn } from "../adsWeeklyEmailWorker.js";

afterEach(() => { vi.useRealTimers(); delete process.env.BF_WEEKLY_EMAILS; ads.mockClear(); summary.mockClear(); });

describe("BF weekly reporting emails", () => {
  it("are paused unless BF_WEEKLY_EMAILS=on", () => {
    expect(weeklyEmailsOn({} as any)).toBe(false);
    expect(weeklyEmailsOn({ BF_WEEKLY_EMAILS: "ON" } as any)).toBe(true);
  });
  it("sends nothing while paused, and both reports once switched on", async () => {
    vi.useFakeTimers();
    const w = startAdsWeeklyEmailWorker({} as any);
    await vi.advanceTimersByTimeAsync(91_000);
    expect(ads).not.toHaveBeenCalled();
    expect(summary).not.toHaveBeenCalled();
    process.env.BF_WEEKLY_EMAILS = "on";
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(ads).toHaveBeenCalledTimes(1);
    expect(summary).toHaveBeenCalledTimes(1);
    w.stop();
  });
});
