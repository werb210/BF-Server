// BF_SERVER_REPORTS11_14_v785 / BF_SERVER_WORKER_STAGGER_v785
import { afterEach, describe, it, expect, vi } from "vitest";
import { bootIndex, type Boot } from "./helpers/bootIndex.js";

vi.mock("../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: async () => ({ rows: [], rowCount: 0 }) } }));
import { DATA } from "../services/reports/data.js";
import { reportByKey } from "../services/reports/catalog.js";

describe("reports 11-14", () => {
  it("are registered with data and a catalog entry", () => {
    for (const k of ["email_performance", "sms_campaign_performance", "website_pages", "lifecycle"]) {
      expect(typeof (DATA as any)[k], k).toBe("function");
      expect(reportByKey(k), k).toBeTruthy();
    }
  });
  it("say what is not recorded instead of guessing", async () => {
    const email = await (DATA as any).email_performance({});
    expect(email.note).toContain("Replies to staff emails are not tracked.");
    const pages = await (DATA as any).website_pages({});
    expect(pages.note).toContain("Country is not recorded for website visits.");
  });
});

describe("background workers start one at a time", () => {
  let boot: Boot | null = null;
  afterEach(() => { boot?.restore(); boot = null; });

  it("after the server is answering, with a pause between each", async () => {
    boot = await bootIndex({ env: { WORKER_STAGGER_MS: undefined } });
    await boot.workersDone();
    const ev = boot.events;
    const starts = ev.map((e, i) => (e.startsWith("start:") ? i : -1)).filter((i) => i >= 0);
    expect(starts.length).toBeGreaterThanOrEqual(26);
    // app.listen() is called before the first worker starts: the workers run in the background.
    expect(ev.indexOf("listen")).toBeGreaterThan(-1);
    expect(ev.indexOf("listen")).toBeLessThan(starts[0]);
    // Default pause 1.5 s, at least 25 of them, and one between every pair of consecutive worker starts.
    expect(boot.timeouts.filter((ms) => ms === 1500).length).toBeGreaterThanOrEqual(25);
    for (let k = 1; k < starts.length; k += 1) {
      expect(ev.slice(starts[k - 1], starts[k]), `${ev[starts[k - 1]]} -> ${ev[starts[k]]}`).toContain("timeout:1500");
    }
  });

  it("WORKER_STAGGER_MS sets the pause and is never negative", async () => {
    boot = await bootIndex({ env: { WORKER_STAGGER_MS: "250" } });
    await boot.workersDone();
    expect(boot.timeouts.filter((ms) => ms === 250).length).toBeGreaterThanOrEqual(25);
    boot.restore();
    boot = await bootIndex({ env: { WORKER_STAGGER_MS: "-40" } });
    await boot.workersDone();
    expect(boot.timeouts).not.toContain(-40);
    expect(boot.timeouts.filter((ms) => ms === 0).length).toBeGreaterThanOrEqual(25);
  });
});
