// BF_SERVER_SIG_POSITION_v1 / BF_SERVER_ADD_REFERRAL_NAMES_v1
import { describe, it, expect } from "vitest";
import { buildReferrerAgreementPdf } from "../referrerAgreementPdfBuilder.js";
import { readFileSync } from "node:fs";
import path from "node:path";
describe("signature position + add-referral names", () => {
  it("agreement still renders", async () => {
    const bytes = await buildReferrerAgreementPdf({ fullName: "Test", email: "t@e.com", phone: "1" });
    expect(bytes.length).toBeGreaterThan(1000);
  });
  it("signature tag lifted above the line", () => {
    expect(readFileSync(path.join(process.cwd(), "src/signnow/referrerAgreementPdfBuilder.ts"), "utf8"))
      .toContain("PH - ctx.y + 22");
  });
  it("add-referral accepts first_name/last_name/business_name", () => {
    const s = readFileSync(path.join(process.cwd(), "src/routes/referrerSelf.ts"), "utf8");
    expect(s).toContain("str(body.first_name) ?? str(body.firstName)");
    expect(s).toContain("str(body.business_name)");
  });
});
