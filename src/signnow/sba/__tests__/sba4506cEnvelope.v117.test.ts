// BF_SERVER_SBA_4506C_ENVELOPE_v117
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const signing = readFileSync(resolve(__dirname, "..", "sbaSigning.ts"), "utf-8");

describe("4506-C in the envelope", () => {
  it("is built per owner, inside the owner loop", () => {
    const loopStart = signing.indexOf("for (const owner of owners)");
    const call = signing.indexOf("buildSba4506c({ business: ctx.business, owner, kyc: ctx.kyc })");
    expect(loopStart).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(loopStart);
  });

  it("is named per owner so five owners do not collide", () => {
    expect(signing).toContain("`irs-4506c-owner${owner.index}-${applicationId}.pdf`");
  });

  // BF_SERVER_PER_LENDER_IVES_v144 - one push per lender now, but a null build
  // still contributes nothing to the envelope.
  it("is skipped when the builder returns null", () => {
    expect(signing).toContain("if (form4506c) {");
    // Every push of a 4506-C sits inside a truthiness check on the build result.
    const pushes = signing.split("docs.push({ bytes: form4506c").length - 1;
    const guards = signing.split("if (form4506c) {").length - 1;
    expect(pushes).toBe(guards);
    expect(pushes).toBe(2);
  });

  it("signs before the 413", () => {
    expect(signing.indexOf("buildSba4506c")).toBeLessThan(signing.indexOf("buildSba413({"));
  });

  it("does not disturb the existing three", () => {
    for (const f of ["buildSba1919", "buildSba912", "buildSba413"]) {
      expect(signing).toContain(f);
    }
  });
});
