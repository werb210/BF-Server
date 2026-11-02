// BF_SERVER_v867_BROKER_TOOLS_RATE_CARDS - CSV grids, rate lookup, payment maths and side-by-side options with sales tax.
import { describe, expect, it } from "vitest";
import { aprPayment, cellsToCsv, csvRows, findCell, parseRateCsv, parseStructureInput, priceOption, structureOptions, type RateCard } from "../rateCards.js";
import { defaultRate } from "../salesTax.js";

const CSV = 'term,min,max,tier,rate\n36,0,49999.99,,9.5\n36,50000,,A,7.9\n36,50000,,any,8.9\n48,0,,,8.5\n"60","0","",B,"10.25%"\n';

const card = (o: Partial<RateCard> = {}): RateCard => {
  const p = parseRateCsv(CSV);
  if (!p.ok) throw new Error(p.error);
  return { id: "c1", lender_id: null, lender_product_id: null, lender_name: "Northern Capital", name: "Equipment 2026", rate_kind: "apr", active: true,
    effective_from: null, min_amount: 10000, max_amount: 500000, fees: [{ label: "Documentation fee", amount: 350, taxable: true, financed: false }], residual_options: [], notes: null, cells: p.cells, ...o };
};

describe("rate cards", () => {
  it("reads CSV with quotes, optional tiers and percent signs; names the bad line", () => {
    expect(csvRows('a,"b,c",d\r\n1,"he said ""hi""",3')).toEqual([["a", "b,c", "d"], ["1", 'he said "hi"', "3"]]);
    const p = parseRateCsv(CSV);
    expect(p.ok && p.cells).toHaveLength(5);
    expect(p.ok && p.cells[4]).toEqual({ term_months: 60, amount_min: 0, amount_max: null, tier: "B", rate: 10.25 });
    expect(parseRateCsv("term,rate\n36,0")).toEqual({ ok: false, error: "Line 2: the rate must be a number above 0." });
    expect(parseRateCsv("months,min\n36,0")).toMatchObject({ ok: false });
    expect(parseRateCsv("term,min,rate\n36,0,9\n36,0,8")).toEqual({ ok: false, error: "Line 3: the same term, amount band and tier appear twice." });
    const back = parseRateCsv(cellsToCsv(card().cells));
    expect(back.ok && back.cells).toEqual(card().cells);
  });

  it("finds the cell: term, amount band, an exact tier before 'any'", () => {
    const cells = card().cells;
    expect(findCell(cells, 36, 40000, "A")?.rate).toBe(9.5);
    expect(findCell(cells, 36, 80000, "A")?.rate).toBe(7.9);
    expect(findCell(cells, 36, 80000, "C")?.rate).toBe(8.9);
    expect(findCell(cells, 60, 80000, "A")).toBeNull();
    expect(findCell(cells, 72, 80000, null)).toBeNull();
  });

  it("works out level payments, with a residual and in advance", () => {
    expect(aprPayment(100000, 0, 50)).toBe(2000);
    expect(Number(aprPayment(100000, 9, 36).toFixed(2))).toBe(3179.97);
    expect(aprPayment(100000, 9, 36, 10000)).toBeLessThan(aprPayment(100000, 9, 36));
    expect(aprPayment(100000, 9, 36, 0, true)).toBeLessThan(aprPayment(100000, 9, 36));
  });

  it("taxes each lease payment in Ontario, or finances the tax on a loan in BC", () => {
    const lease = parseStructureInput({ amount: 80000, province: "ON", terms: [36], tier: "A", tax_mode: "lease" });
    if (!lease.ok) throw new Error(lease.error);
    const o = priceOption(card(), lease.value, 36, defaultRate("ON"))!;
    expect(o).toMatchObject({ rate: 7.9, tier: "A", financed: 80000 });
    expect(o.payment_tax[0]!.label).toBe("HST 13%");
    expect(o.payment_with_tax).toBeCloseTo(o.payment * 1.13, 1);
    expect(o.upfront).toEqual([{ label: "Documentation fee", amount: 350 }, { label: "HST 13% on Documentation fee", amount: 45.5 }]);

    const loan = parseStructureInput({ amount: 80000, province: "BC", terms: [36], tax_mode: "financed" });
    if (!loan.ok) throw new Error(loan.error);
    const l = priceOption(card(), loan.value, 36, defaultRate("BC"))!;
    expect(l.financed).toBe(89600); // GST 5% + PST 7% financed with the equipment
    expect(l.payment_tax).toEqual([]);
  });

  it("puts every eligible card side by side per term, cheapest first, and skips cards outside their amount range", () => {
    const input = parseStructureInput({ amount: 80000, province: "AB", terms: "36, 48", tax_mode: "lease" });
    if (!input.ok) throw new Error(input.error);
    const factor = card({ id: "c2", name: "Fast cash", lender_name: "Quick Funding", rate_kind: "factor", fees: [],
      cells: [{ term_months: 36, amount_min: 0, amount_max: null, tier: "any", rate: 1.3 }] });
    const tooSmall = card({ id: "c3", max_amount: 50000 });
    const opts = structureOptions([factor, card(), tooSmall], input.value, defaultRate("AB"));
    expect(opts.map((o) => `${o.card_id}:${o.term_months}`)).toEqual(["c1:36", "c2:36", "c1:48"]);
    expect(opts[1]).toMatchObject({ payment: 2888.89, rate_kind: "factor" });
    expect(parseStructureInput({ amount: 0 }).ok).toBe(false);
    expect(parseStructureInput({ amount: 1000, down_payment: 1000 }).ok).toBe(false);
  });
});
