import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
const src = readFileSync(fileURLToPath(new URL("../routes/mayaStaff.ts", import.meta.url)), "utf-8");
describe("Maya marketing tools", () => {
  it("exposes overview + gated send", () => {
    expect(src).toContain("/staff/marketing-overview");
    expect(src).toContain("/staff/marketing-send");
  });
  it("gates send behind confirm===true (preview otherwise)", () => {
    expect(src).toContain("const confirm = req.body?.confirm === true;");
    expect(src).toContain("preview: true");
  });
});
