// BF_SERVER_v865_BROKER_TOOLS_3_SALES_TAX - the sales-tax helper: provinces, tax lines, Admin input checks, the dated rate lookup
// (database faked by SQL content) and the fee-tax function the quote maths uses.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATES, PROVINCES, combinedRate, currentRates, defaultRate, feeTaxFor, normaliseProvince, parseRateInput, rateOn, salesTax,
} from "../salesTax.js";

describe("sales tax helper", () => {
  it("reads province names and codes, and rejects anything else", () => {
    expect(normaliseProvince(" ontario ")).toBe("ON");
    expect(normaliseProvince("qc")).toBe("QC");
    expect(normaliseProvince("Qu\u00e9bec")).toBe("QC");
    expect(normaliseProvince("PEI")).toBe("PE");
    expect(normaliseProvince("Texas")).toBeNull();
    expect(normaliseProvince("")).toBeNull();
  });

  it("has a built-in rate for every province and territory", () => {
    expect(DEFAULT_RATES.map((r) => r.province).sort()).toEqual([...PROVINCES].sort());
    expect(combinedRate(defaultRate("NS"))).toBe(14);
    expect(combinedRate(defaultRate("QC"))).toBe(14.975);
    expect(combinedRate(defaultRate("AB"))).toBe(5);
  });

  it("splits the tax into the lines a customer sees", () => {
    expect(salesTax(1000, defaultRate("ON"))).toEqual({ lines: [{ label: "HST 13%", amount: 130 }], total: 130 });
    expect(salesTax(1000, defaultRate("BC")).lines).toEqual([{ label: "GST 5%", amount: 50 }, { label: "PST 7%", amount: 70 }]);
    expect(salesTax(1000, defaultRate("MB")).lines[1]).toEqual({ label: "RST 7%", amount: 70 });
    expect(salesTax(1000, defaultRate("QC"))).toEqual({ lines: [{ label: "GST 5%", amount: 50 }, { label: "QST 9.975%", amount: 99.75 }], total: 149.75 });
    expect(salesTax(0, defaultRate("ON")).lines).toEqual([]);
  });

  it("checks an Admin's edit", () => {
    expect(parseRateInput({ province: "ON", effective_from: "2027-01-01", hst: "14" })).toMatchObject({ ok: true, rate: { province: "ON", hst: 14, gst: 0 } });
    expect(parseRateInput({ province: "ON", effective_from: "2027-02-30", hst: 13 }).ok).toBe(false);
    expect(parseRateInput({ province: "ON", effective_from: "2027-01-01", hst: 13, gst: 5 }).ok).toBe(false);
    expect(parseRateInput({ province: "QC", effective_from: "2027-01-01", gst: 5, pst: 1, qst: 9.975 }).ok).toBe(false);
    expect(parseRateInput({ province: "AB", effective_from: "2027-01-01", gst: 50 }).ok).toBe(false);
    expect(parseRateInput({ province: "Ohio", effective_from: "2027-01-01", gst: 5 }).ok).toBe(false);
  });

  it("picks the row in force on the day, and falls back to the built-in rate", async () => {
    const rows = [
      { province: "ON", effective_from: "2025-04-01", gst: 0, pst: 0, hst: 13, qst: 0, note: null },
      { province: "ON", effective_from: "2027-01-01", gst: 0, pst: 0, hst: 14, qst: 0, note: null },
    ];
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        if (/FROM sales_tax_rates/.test(sql) && /effective_from <= \$2/.test(sql)) {
          const [p, d] = params as string[];
          return { rows: rows.filter((r) => r.province === p && r.effective_from <= d).sort((a, b) => b.effective_from.localeCompare(a.effective_from)).slice(0, 1) };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };
    expect((await rateOn(db, "ON", "2026-12-31")).hst).toBe(13);
    expect((await rateOn(db, "ON", "2027-01-01")).hst).toBe(14);
    expect(await rateOn(db, "BC", "2026-12-31")).toEqual(defaultRate("BC"));
    const broken = { query: async () => { throw new Error("relation does not exist"); } };
    expect(await rateOn(broken, "SK")).toEqual(defaultRate("SK"));
    const cur = currentRates(rows as any, "2026-11-01");
    expect(cur.find((r) => r.province === "ON")!.hst).toBe(13);
    expect(cur).toHaveLength(PROVINCES.length);
  });

  it("taxes only the fees ticked taxable", () => {
    const fees = [{ amount: 300, taxable: true }, { amount: 200 }];
    expect(feeTaxFor(defaultRate("ON"))(fees)).toEqual([{ label: "HST 13%", amount: 39 }]);
    expect(feeTaxFor(defaultRate("SK"))(fees)).toEqual([{ label: "GST 5%", amount: 15 }, { label: "PST 6%", amount: 18 }]);
    expect(feeTaxFor(null)(fees)).toEqual([]);
  });
});
