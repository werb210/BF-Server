// BF_SERVER_v957_OFFER_IN_APP
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { termSheetGroupName } from "../sendOfferTermSheet.js";

describe("the name SignNow shows the client", () => {
  it("is plain words with the lender's name", () => {
    expect(termSheetGroupName("Todd's lending company")).toBe("Term sheet from Todd's lending company");
    expect(termSheetGroupName("  ")).toBe("Term sheet");
    expect(termSheetGroupName(null)).toBe("Term sheet");
  });
  it("never carries the offer's id, and our own term sheet never names the lender", () => {
    const src = readFileSync(new URL("../sendOfferTermSheet.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/createDocumentGroup\([^)]*offer\.id/);
    expect(src).not.toMatch(/uploadDocumentWithFieldExtract\([^)]*offer\.id/);
    expect(src).toContain('offer.term_sheet_mode === "ours" ? "Boreal Financial"');
  });
});

describe("the term sheet for the client app", () => {
  it("is served in its viewing form to a signed-in client who owns the offer", () => {
    const src = readFileSync(new URL("../../../routes/offers.ts", import.meta.url), "utf8");
    const at = src.indexOf('router.get("/:id/term-sheet-view"');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 900);
    expect(body).toContain("requireAuthAllowClient");
    expect(body).toContain("requireOfferAccess");
    expect(body).toContain("termSheetForViewing");
  });
});
