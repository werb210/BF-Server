import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startKeepWarm } from "../keepWarm";

describe("BF_SERVER_BLOCK_v105_KEEP_WARM_v1", () => {
  it("exports startKeepWarm", () => {
    expect(typeof startKeepWarm).toBe("function");
  });

  it("references WEBSITE_HOSTNAME and /health", () => {
    const sourcePath = path.resolve(__dirname, "..", "keepWarm.ts");
    const source = fs.readFileSync(sourcePath, "utf8");
    expect(source).toContain("WEBSITE_HOSTNAME");
    expect(source).toContain("/health");
  });
});
