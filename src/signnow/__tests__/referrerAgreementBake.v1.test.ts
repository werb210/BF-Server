// BF_SERVER_REFERRER_AGREEMENT_BAKE_v1
import { describe, it, expect } from "vitest";
import { buildReferrerAgreementPdf } from "../referrerAgreementPdfBuilder.js";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("referrer agreement bake-in", () => {
  it("renders a PDF with the referrer's details baked in", async () => {
    const bytes = await buildReferrerAgreementPdf({
      fullName: "Gloria Werboweski", company: "Test Co", email: "g@example.com",
      phone: "4033189220", street: "123 Any St", cityProvincePostal: "Anytown AB T2P1P6",
      payoutEmail: "g@example.com",
    });
    expect(bytes.length).toBeGreaterThan(1000);
    expect(new TextDecoder("latin1").decode(bytes.slice(0, 5))).toContain("%PDF");
  });

  it("session generates+uploads (no template/prefill) and only needs the API key", () => {
    const s = readFileSync(path.join(process.cwd(), "src/modules/referrals/referrerAgreement.service.ts"), "utf8");
    expect(s).toContain("buildReferrerAgreementPdf({");
    expect(s).toContain("uploadDocumentWithFieldExtract(");
    expect(s).not.toContain("await prefillTextFields(");
    expect(s).not.toContain("createDocumentFromTemplate(");
  });
});
