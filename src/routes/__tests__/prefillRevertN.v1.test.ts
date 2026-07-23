// BF_SERVER_REFERRER_PREFILL_REVERT_N_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const r = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
describe("revert invalid n: template tags", () => {
  it("PDF builder no longer uses n: field-name attributes", () => {
    expect(r("src/signnow/referrerAgreementPdfBuilder.ts")).not.toContain('n:"ref_');
  });
  // BF_SERVER_REPAIR_STALE_TESTS_v1 - field DISCOVERY existed only to locate a
  // template's field names so they could be prefilled. The bake approach prints the
  // values into the PDF before upload, so there is nothing to discover and nothing
  // to prefill. Assert the service is genuinely off that path rather than asserting
  // for machinery that was deliberately removed.
  it("no longer discovers or prefills template fields", () => {
    const s = r("src/modules/referrals/referrerAgreement.service.ts");
    expect(s).not.toContain("getDocumentTextFields(documentId)");
    expect(s).not.toContain("prefillTextFields(documentId");
    expect(s).toContain("buildReferrerAgreementPdf");
  });
});
