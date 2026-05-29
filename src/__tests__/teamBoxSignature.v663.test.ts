import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
const s = readFileSync("src/routes/o365.ts", "utf-8");
describe("v663 team-box signature", () => {
  it("tracks personal vs shared send", () => {
    expect(s).toContain("let sendingAsSelf = true;");
    expect(s).toContain("sendingAsSelf = false;");
  });
  it("applies personal signature only when sending as self", () => {
    expect(s).toContain("if (sendingAsSelf) {");
    // signature query must sit inside the sendingAsSelf guard, after from-resolution
    const guardIdx = s.indexOf("if (sendingAsSelf) {");
    const sigIdx = s.indexOf("email_signature_html FROM user_settings", guardIdx);
    expect(sigIdx).toBeGreaterThan(guardIdx);
  });
});
