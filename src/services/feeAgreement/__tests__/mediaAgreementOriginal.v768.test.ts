// BF_SERVER_MEDIA_AGREEMENT_ORIGINAL_v768
import { describe, it, expect } from "vitest";
import { agreementParagraphs, scheduleAFeeText, scheduleARows } from "../../../signnow/mediaFeeAgreementPdfBuilder.js";

const all = agreementParagraphs({ agreementDate: "October 6, 2026" }).map((p) => (p.bold ?? "") + " " + p.text).join("\n");

describe("the media agreement is back to the original wording", () => {
  it("original definition, exclusivity and non-circumvention", () => {
    expect(all).toContain("the term \"financing\" shall mean the procuring of a written commitment");
    expect(all).toContain("The Client hereby engages BF as Exclusive Agent commencing on the date of signing");
    expect(all).toContain("disclosed by the Client to BF during the term of this Agreement");
    expect(all).not.toContain("BF Lender");
  });
  it("original fee text and Schedule A rows", () => {
    expect(scheduleAFeeText()).toContain("of the gross total of any and all financing procured by BF or with BF's assistance");
    expect(scheduleARows({ agreementDate: "x" }).map((r) => r[0])).not.toContain("BF FEE");
  });
});
