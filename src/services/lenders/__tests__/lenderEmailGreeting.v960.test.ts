// BF_SERVER_v960_LENDER_REPS - a package sent to the rep handling the file greets them by name.
import { describe, expect, it } from "vitest";
import { lenderEmail } from "../lenderEmail.js";

const base = { lenderName: "Sample Lender", applicationId: "11111111-1111-4111-8111-111111111111", businessName: "Sample Co" };
describe("lender email greeting", () => {
  it("greets the lender's team when no rep is handling the file", () => {
    const e = lenderEmail(base, { mode: "attached", sizeBytes: 1024 });
    expect(e.bodyText).toMatch(/^Hello Sample Lender team,/);
    expect(e.bodyHtml).toContain("Hello Sample Lender team,");
  });
  it("greets the rep by name", () => {
    const e = lenderEmail({ ...base, greeting: "Pat" }, { mode: "attached", sizeBytes: 1024 });
    expect(e.bodyText).toMatch(/^Hello Pat,/);
    expect(e.bodyHtml).toContain("Hello Pat,");
    expect(e.bodyText).not.toMatch(/team,/);
  });
});
