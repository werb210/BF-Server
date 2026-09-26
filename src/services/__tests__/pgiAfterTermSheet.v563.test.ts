// BF_SERVER_BLOCK_v563
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("v563 PGI waits for a signed term sheet", () => {
  it("the client thread hides the PGI prompt until signed", () => {
    const s = readFileSync("src/routes/client/index.ts", "utf-8");
    expect(s).toContain("if (!(await termSheetSigned(applicationId))) {");
  });
  it("the submit-time SMS with the PGI link waits too", () => {
    const s = readFileSync("src/routes/client/v1Applications.ts", "utf-8");
    expect(s).toContain("if (v650_to && (await (await import(\"../../services/termSheetSigned.js\")).termSheetSigned(");
  });
  it("signing the term sheet sends the PGI link", () => {
    const s = readFileSync("src/routes/signnow.ts", "utf-8");
    expect(s).toContain("await sendPgiLinkAfterTermSheet(applicationId);");
    const svc = readFileSync("src/services/termSheetSigned.ts", "utf-8");
    expect(svc).toContain("document_type = 'signed_term_sheet'");
    expect(svc).toContain("trigger = 'offer_term_sheet_signed'");
  });
});
