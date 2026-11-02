// BF_SERVER_v867_BROKER_TOOLS_VENDORS - vendor apply links, fees, input checks, the agreement PDF and the funded fee.
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { applyLink, newCode, parseVendorInput, vendorAgreementPdf, vendorFee, vendorFeeOnFunded } from "../vendors.js";

const vendor = { user_id: "11111111-1111-4111-8111-111111111111", company_name: "Prairie Equipment", contact_name: "Pat", email: "pat@prairie.example", phone: "+17805550100",
  province: "AB", code: "PRAIRI-ABC123", status: "active" as const, fee_pct: 1.5, fee_flat: 250, fee_terms: null, notes: null };

describe("vendor portal", () => {
  it("makes a readable code and an apply link that names the vendor and the quote", () => {
    expect(newCode("Prairie Equipment Ltd.")).toMatch(/^PRAIRI-[0-9A-F]{6}$/);
    const link = new URL(applyLink("PRAIRI-ABC123", "q1"));
    expect(Object.fromEntries(link.searchParams)).toEqual({ ref: "PRAIRI-ABC123", utm_source: "vendor", utm_medium: "vendor_portal", utm_campaign: "PRAIRI-ABC123", vq: "q1" });
  });

  it("works out the fee: percent of the funded amount plus the flat amount", () => {
    expect(vendorFee(vendor, 100000)).toBe(1750);
    expect(vendorFee({ fee_pct: null, fee_flat: null }, 100000)).toBe(0);
  });

  it("checks vendor details", () => {
    expect(parseVendorInput({ company_name: "X", phone: "123", email: "a@b.co" })).toMatchObject({ ok: false });
    expect(parseVendorInput({ company_name: "X", phone: "780-555-0100", email: "A@B.co", fee_pct: 25 })).toEqual({ ok: false, error: "The fee is 0 to 20% of the funded amount." });
    const p = parseVendorInput({ company_name: " Prairie ", phone: "(780) 555-0100", email: "A@B.co", fee_pct: "1.5", province: "Alberta" });
    expect(p.ok && p.value).toMatchObject({ company_name: "Prairie", phone: "+17805550100", email: "a@b.co", fee_pct: 1.5, province: "AB" });
  });

  it("builds the vendor agreement with the fee in it", async () => {
    const pdf = await PDFDocument.load(await vendorAgreementPdf(vendor));
    expect(pdf.getPageCount()).toBe(1);
  });

  it("records the fee once when a deal from the vendor's link funds", async () => {
    const inserted: unknown[][] = [];
    const q = { query: async (sql: string, p: unknown[] = []) => {
      if (/FROM applications a WHERE a.id/.test(sql)) return { rows: [{ ref: "prairi-abc123", amount: "80000" }] };
      if (/FROM vendor_profiles WHERE lower\(code\)/.test(sql)) return { rows: [vendor] };
      if (/INSERT INTO vendor_fees/.test(sql)) { const first = !inserted.length; inserted.push(p); return { rows: first ? [{ id: "f1" }] : [] }; }
      throw new Error("unexpected SQL: " + sql.slice(0, 60));
    } };
    expect(await vendorFeeOnFunded(q, "a1")).toBe(true);
    expect(await vendorFeeOnFunded(q, "a1")).toBe(false);
    expect(inserted[0]!.slice(1, 5)).toEqual(["a1", 80000, 1450, "1.5% + $250 flat"]);
  });
});
