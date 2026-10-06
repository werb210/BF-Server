// BF_SERVER_MEDIA_AGREEMENT_BF_LENDERS_v766
import { describe, it, expect } from "vitest";
import { agreementParagraphs, buildMediaFeeAgreementPdf, scheduleAFeeText, scheduleARows } from "../../../signnow/mediaFeeAgreementPdfBuilder.js";

const data = { agreementDate: "October 6, 2026", companyName: "Gateway Films", clientName: "Dylan Pearce" };
const all = agreementParagraphs(data).map((p) => (p.bold ?? "") + " " + p.text).join("\n");

describe("media services agreement - the client's review points", () => {
  it("exclusivity covers only lenders Boreal introduces; the client stays free to finance elsewhere", () => {
    expect(all).toContain("\"BF Lender\" means a lender or financing source that BF first introduces to the Client");
    expect(all).toContain("exclusive agent with respect to BF Lenders only");
    expect(all).toContain("Nothing in this Agreement restricts the Client from pursuing or obtaining financing through any other lender, broker or source independently of BF");
    expect(all).not.toContain("Exclusive Agent commencing");
  });
  it("non-circumvention and the one-year tail apply only to BF Lenders; nothing the client brings is caught", () => {
    expect(all).not.toMatch(/by the Client to BF/);
    expect(all).toContain("shall not contact or transact with any BF Lender other than through BF");
    expect(all).toContain("does not apply to any lender or financing source that is not a BF Lender");
  });
  it("the fee is earned only when BF Lender financing closes and funds, not on a commitment", () => {
    expect(all).not.toContain("procuring of a written commitment");
    expect(scheduleAFeeText()).toContain("earned and payable only if and when that financing closes and funds");
    expect(scheduleAFeeText()).toContain("No fee is earned or payable on a commitment that does not close and fund");
    expect(scheduleAFeeText()).toContain("BF charges no other fees or expenses");
  });
  it("Schedule A shows the amount, fee and expenses", async () => {
    const rows = Object.fromEntries(scheduleARows(data));
    expect(rows["APPROXIMATE FINANCING AMOUNT"]).toBe("To be confirmed in the lender's term sheet");
    expect(rows["BF FEE"]).toBe("2.0% of financing from a BF Lender, paid only at funding");
    expect(rows["BF EXPENSES"]).toBe("None");
    expect(Buffer.from(await buildMediaFeeAgreementPdf(data)).subarray(0, 4).toString()).toBe("%PDF");
  });
});
