// BF_SERVER_SCORECARD_NAMES_v787
import { describe, it, expect, vi } from "vitest";
const sqls: string[] = [];
vi.mock("../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: async (sql: string) => { sqls.push(sql); return { rows: [{ lender_id: "L1", lender: "Bizcap", sent: 2, offers: 0, funded: 0, days_to_offer: null }] }; } } }));
import { lenderScorecard } from "../services/reports/data.js";

describe("lender scorecard names every lender", () => {
  it("resolves lender ids, product ids (to their lender) and stored names", async () => {
    const r = await lenderScorecard(180);
    expect(r.lenders[0].lender).toBe("Bizcap");
    const sql = sqls[0]!;
    expect(sql).toContain("LEFT JOIN lender_products p ON p.id = s0.raw_id");
    expect(sql).toContain("LEFT JOIN lenders lp ON lp.id = p.lender_id");
    expect(sql).toContain("COALESCE(l.name, lp.name,");
    expect(sql).not.toContain("COALESCE(l.name, 'Lender')");
  });
});
