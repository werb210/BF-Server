// BF_SERVER_AGREEMENT_COUNTERSIGN_v747
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildReferrerAgreementPdf } from "../signnow/referrerAgreementPdfBuilder.js";
import { buildBrokerAgreementPdf } from "../signnow/brokerAgreementPdfBuilder.js";

describe("Boreal signs its side of the referrer and broker agreements", () => {
  for (const p of ["src/signnow/referrerAgreementPdfBuilder.ts", "src/signnow/brokerAgreementPdfBuilder.ts"]) {
    it(p + " carries Boreal's electronic signature and no unkept promise", () => {
      const s = readFileSync(p, "utf8");
      expect(s).toContain('text(ctx, "/s/ Todd Werboweski", 14, SIG, BLACK);');
      expect(s).toContain('"Signed electronically for Boreal Financial Group on "');
      expect(s).not.toContain("Countersigned by Boreal Financial Group upon acceptance.");
    });
  }
  it("both agreements still build", async () => {
    expect((await buildReferrerAgreementPdf({ fullName: "Dana R" } as any)).length).toBeGreaterThan(1000);
    expect((await buildBrokerAgreementPdf({ fullName: "Dana R" } as any)).length).toBeGreaterThan(1000);
    expect((await buildReferrerAgreementPdf()).length).toBeGreaterThan(1000);
  });
});
