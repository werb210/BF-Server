// BF_SERVER_REFERRER_PREFILL_REVERT_N_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const r = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
describe("revert invalid n: template tags", () => {
  it("PDF builder no longer uses n: field-name attributes", () => {
    expect(r("src/signnow/referrerAgreementPdfBuilder.ts")).not.toContain('n:"ref_');
  });
  it("field discovery path is still present (logs real field names)", () => {
    const s = r("src/modules/referrals/referrerAgreement.service.ts");
    expect(s).toContain("getDocumentTextFields(documentId)");
    expect(s).toContain("[referrer_agreement] doc text fields");
  });
});
