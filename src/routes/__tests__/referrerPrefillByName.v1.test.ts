// BF_SERVER_REFERRER_PREFILL_BY_NAME_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const r = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("referrer prefill maps labels to real field names", () => {
  it("client can read a document's text fields (name + label)", () => {
    const c = r("src/signnow/signnowClient.ts");
    expect(c).toContain("export async function getDocumentTextFields");
    expect(c).toContain("json_attributes");
  });
  // BF_SERVER_REPAIR_STALE_TESTS_v1 - label->name mapping and the positional fallback
  // were scaffolding for template prefill. The bake approach removed the need for
  // both. getDocumentTextFields is KEPT on the client as a diagnostic, so the first
  // assertion above still stands; only the service-side mapping is gone.
  it("the service no longer maps or prefills fields at all", () => {
    const s = r("src/modules/referrals/referrerAgreement.service.ts");
    expect(s).not.toContain("byLabel.get(");
    expect(s).not.toContain("positional prefill fallback");
    expect(s).toContain("BF_SERVER_REFERRER_AGREEMENT_BAKE_v1");
  });
});
