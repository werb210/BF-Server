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
  it("service maps by label then prefills by real name, with positional fallback", () => {
    const s = r("src/modules/referrals/referrerAgreement.service.ts");
    expect(s).toContain("getDocumentTextFields(documentId)");
    expect(s).toContain("byLabel.get(w.label.toLowerCase())");
    expect(s).toContain("positional prefill fallback");
    // no longer prefills by raw label as the name
    expect(s).not.toContain('{ name: "Full name", value: params.fullName }');
  });
});
