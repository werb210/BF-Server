// BF_SERVER_GA4_QUOTA_v386
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const g = vi.hoisted(() => ({ active: 0, peak: 0, calls: 0, fail: null as null | Error }));

vi.mock("../observability/logger.js", () => ({ logError: () => {} }));

import { __resetGa4StateForTests, __setGa4GoogleForTests, isGa4QuotaError, runGa4Report } from "../services/ga4Service.js";

const fakeGoogle = {
  google: {
    auth: { GoogleAuth: class { constructor(_: unknown) {} } },
    analyticsdata: () => ({
      properties: {
        runReport: async () => {
          g.calls += 1;
          g.active += 1;
          g.peak = Math.max(g.peak, g.active);
          await new Promise((r) => setTimeout(r, 5));
          g.active -= 1;
          if (g.fail) throw g.fail;
          return { data: { rows: [{ dimensionValues: [{ value: "x" }], metricValues: [{ value: "7" }, { value: "3" }] }] } };
        },
      },
    }),
  },
};

beforeEach(() => {
  process.env.GA4_SA_JSON = JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com", private_key: "k" });
  process.env.GA4_PROPERTY_ID = "123";
  Object.assign(g, { active: 0, peak: 0, calls: 0, fail: null });
  __resetGa4StateForTests();
  __setGa4GoogleForTests(fakeGoogle);
});
afterEach(() => vi.useRealTimers());

describe("GA4 stays inside its quota", () => {
  it("never has more than 4 GA4 calls in flight", async () => {
    const r: any = await runGa4Report(30);
    expect(r.error).toBeUndefined();
    expect(g.calls).toBe(15);
    expect(g.peak).toBeLessThanOrEqual(4);
  });
  it("two panels asking at once share one run", async () => {
    const [a, b]: any[] = await Promise.all([runGa4Report(30), runGa4Report(30)]);
    expect(g.calls).toBe(15);
    expect(a.summary.sessions).toBe(b.summary.sessions);
  });
  it("keeps each date range cached separately", async () => {
    await runGa4Report(7);
    await runGa4Report(30);
    const again: any = await runGa4Report(7);
    expect(again.cached).toBe(true);
    expect(g.calls).toBe(30);
  });
  it("on a quota error serves the last good figures and backs off", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await runGa4Report(30);
    vi.setSystemTime(Date.now() + 31 * 60_000); // cache expired
    g.fail = Object.assign(new Error("Exhausted concurrent requests quota."), {});
    const stale: any = await runGa4Report(30);
    expect(stale.stale).toBe(true);
    expect(stale.summary.activeUsers).toBe(7);
    const callsAfterFailure = g.calls;
    await runGa4Report(30); // inside the back-off: GA4 is not called again
    expect(g.calls).toBe(callsAfterFailure);
  });
  it("without earlier figures, explains the quota error plainly", async () => {
    g.fail = new Error("Exhausted property tokens per hour.");
    const r: any = await runGa4Report(90);
    expect(r.error).toMatch(/over its request limit/);
  });
  it("recognises GA4 quota messages", () => {
    for (const m of ["Exhausted concurrent requests quota.", "RESOURCE_EXHAUSTED", "Request had 429 Too Many Requests"]) {
      expect(isGa4QuotaError(m)).toBe(true);
    }
    expect(isGa4QuotaError("The caller does not have permission")).toBe(false);
  });
});
