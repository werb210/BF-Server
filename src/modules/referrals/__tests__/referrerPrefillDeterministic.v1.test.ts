// BF_SERVER_REFERRER_PREFILL_DETERMINISTIC_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const r = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
describe("deterministic referrer prefill", () => {
  it("template gives every field an explicit n: name", () => {
    const s = r("src/signnow/referrerAgreementPdfBuilder.ts");
    for (const n of ["ref_full_name","ref_company","ref_email","ref_phone","ref_street","ref_city_prov_postal","ref_payout_email","ref_date"]) {
      expect(s).toContain(`n:"${n}"`);
    }
  });
  it("service prefills by those exact names, with discovery fallback", () => {
    const s = r("src/modules/referrals/referrerAgreement.service.ts");
    expect(s).toContain('{ name: "ref_full_name", value: params.fullName }');
    expect(s).toContain("await prefillTextFields(documentId, byName)");
    expect(s).toContain("getDocumentTextFields(documentId)"); // fallback kept
  });
});
