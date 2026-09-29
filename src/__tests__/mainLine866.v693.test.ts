// BF_SERVER_MAIN_LINE_866_v693
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("public numbers and personal numbers", () => {
  it("rejection emails give the 866 main line", () => {
    const s = readFileSync("src/services/rejectionNotice.ts", "utf8");
    expect(s).not.toContain("451-1768");
    expect(s.split("+1 (866) 631-8939").length - 1).toBe(2);
  });
  it("confidence-check lead alerts take their number from LEAD_ALERT_SMS_TO, not from code", () => {
    const s = readFileSync("src/modules/ai/confidence.routes.ts", "utf8");
    expect(s).not.toMatch(/587.?888.?1837/);
    expect(s).toContain("process.env.LEAD_ALERT_SMS_TO");
  });
});
