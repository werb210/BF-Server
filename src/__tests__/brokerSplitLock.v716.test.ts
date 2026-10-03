// BF_SERVER_BROKER_SPLIT_LOCK_v716
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

let row: any = null;
vi.mock("../db.js", () => ({ pool: { query: vi.fn(async (sql: string) => (/FROM applications a LEFT JOIN broker_deal_confirmations/.test(sql) ? { rows: row ? [row] : [] } : { rows: [] })) } }));
import { brokerSplitBlocker } from "../services/brokerImport/splitLock.js";

describe("broker files are locked until the split is accepted", () => {
  it("a normal (non-broker) file is never blocked", async () => {
    row = null;
    expect(await brokerSplitBlocker("a1")).toEqual({ blocked: false });
  });
  it("a broker file with no split, or only a proposal, is blocked", async () => {
    row = { broker: "Avance", status: null };
    expect(await brokerSplitBlocker("a1")).toEqual({ blocked: true, status: null, broker: "Avance" });
    row = { broker: "Avance", status: "proposed" };
    expect((await brokerSplitBlocker("a1")).blocked).toBe(true);
  });
  it("an accepted split unlocks it", async () => {
    row = { broker: "Avance", status: "accepted" };
    expect(await brokerSplitBlocker("a1")).toEqual({ blocked: false });
  });
  it("the lender send route checks it before submitting", () => {
    const src = readFileSync("src/routes/portal.ts", "utf8");
    const i = src.indexOf('\"/lender-submissions\"');
    expect(src.indexOf("brokerSplitBlocker(applicationId)", i)).toBeGreaterThan(i);
    expect(src).toContain('error: "broker_split_not_agreed"');
  });
  it("staff entering who agreed for the broker locks it; otherwise it is a proposal; payouts recorded", () => {
    const src = readFileSync("src/routes/brokerImports.ts", "utf8");
    expect(src).toContain('const status = agreedName ? "accepted" : "proposed";');
    expect(src.indexOf('router.put("/deal/:applicationId", ...staff')).toBeLessThan(src.indexOf('router.put("/deal/:applicationId",...staff'));
    expect(src).toContain('router.put("/deal/:applicationId/payout"');
  });
});
