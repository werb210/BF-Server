// BF_SERVER_REPORTS11_14_v785 / BF_SERVER_WORKER_STAGGER_v785
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DATA } from "../services/reports/data.js";
import { reportByKey } from "../services/reports/catalog.js";

describe("reports 11-14", () => {
  it("are registered with data and a catalog entry", () => {
    for (const k of ["email_performance", "sms_campaign_performance", "website_pages", "lifecycle"]) {
      expect(typeof (DATA as any)[k], k).toBe("function");
      expect(reportByKey(k), k).toBeTruthy();
    }
  });
  it("say what is not recorded instead of guessing", () => {
    const s = readFileSync("src/services/reports/data7.ts", "utf8");
    expect(s).toContain("Replies to staff emails are not tracked.");
    expect(s).toContain("Country is not recorded for website visits.");
  });
});

describe("background workers start one at a time", () => {
  const s = readFileSync("src/index.ts", "utf8");
  it("after the server is answering, with a pause between each", () => {
    expect(s).toContain("void (async () => {");
    expect(s).toContain('const staggerMs = Math.max(0, Number(process.env.WORKER_STAGGER_MS ?? 1500));');
    expect((s.match(/await workerStagger\(\);/g) ?? []).length).toBeGreaterThanOrEqual(25);
    expect(s.indexOf("void (async () => {")).toBeLessThan(s.indexOf('const httpServer = app.listen('));
  });
});
