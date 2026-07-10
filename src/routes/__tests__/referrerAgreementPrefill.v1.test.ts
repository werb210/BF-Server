// BF_SERVER_REFERRER_AGREEMENT_PREFILL_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const r = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("referrer agreement prefill", () => {
  it("client exposes prefillTextFields hitting the SignNow prefill endpoint", () => {
    const c = r("src/signnow/signnowClient.ts");
    expect(c).toContain("export async function prefillTextFields");
    expect(c).toContain("/prefill-texts");
    expect(c).toContain("prefilled_text");
  });
  it("agreement session pre-fills every field label from signup", () => {
    const s = r("src/modules/referrals/referrerAgreement.service.ts");
    for (const label of ["Full name", "Company", "Email", "Phone", "Street address", "City Province Postal", "Payout email", "Date"]) {
      expect(s).toContain(`"${label}"`);
    }
    expect(s).toContain("prefillTextFields(documentId");
  });
  it("signup passes profile data to the session", () => {
    const s = r("src/routes/referrerSelf.ts");
    expect(s).toContain("company, phone, street, city, province, postal, etransfer");
  });
});
