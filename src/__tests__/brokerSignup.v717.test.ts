// BF_SERVER_BROKER_SIGNUP_v717
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildBrokerAgreementPdf } from "../signnow/brokerAgreementPdfBuilder.js";

describe("broker sign-up", () => {
  it("the broker link signs up with kind broker and signs the broker agreement", () => {
    const src = readFileSync("src/routes/referrerSelf.ts", "utf8");
    expect(src).toContain('const isBroker = str(b.kind) === "broker";');
    expect(src).toContain("createBrokerAgreementSession(");
  });
  it("builds the broker agreement PDF with a signature field", async () => {
    const pdf = await buildBrokerAgreementPdf({ fullName: "A B", company: "Brokerage Inc", email: "a@b.com" });
    expect(pdf.length).toBeGreaterThan(5000);
    expect(readFileSync("src/signnow/brokerAgreementPdfBuilder.ts", "utf8")).toContain("{{t:s;r:y;");
  });
});
