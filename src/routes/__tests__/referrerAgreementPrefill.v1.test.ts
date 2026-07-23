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
  // BF_SERVER_REPAIR_STALE_TESTS_v1 - the labels moved from the service (which used
  // to prefill them onto a template) into the PDF builder, which now prints them.
  // The behaviour under test is unchanged - every signup field must reach the
  // agreement - so assert it where it now lives.
  it("the generated PDF carries every field captured at signup", () => {
    const b = r("src/signnow/referrerAgreementPdfBuilder.ts");
    for (const label of ["Full name", "Company", "Email", "Phone", "Street address", "Payout (e-Transfer) email"]) {
      expect(b).toContain(`"${label}"`);
    }
  });
  it("the service passes every signup value into the builder", () => {
    const s = r("src/modules/referrals/referrerAgreement.service.ts");
    for (const field of ["fullName:", "company:", "email:", "phone:", "street:", "cityProvincePostal:", "payoutEmail:"]) {
      expect(s).toContain(field);
    }
  });
  it("signup passes profile data to the session", () => {
    const s = r("src/routes/referrerSelf.ts");
    expect(s).toContain("company, phone, street, city, province, postal, etransfer");
  });
});
