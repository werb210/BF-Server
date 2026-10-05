// BF_SERVER_ABANDON_STOP_v760
import { describe, it, expect } from "vitest";
import { ABANDON_SMS_BODY } from "../workers/abandonedApplicationWorker.js";

describe("finish-your-application text", () => {
  it("names Boreal Financial and tells the client how to opt out", () => {
    expect(ABANDON_SMS_BODY).toContain("Boreal Financial");
    expect(ABANDON_SMS_BODY.endsWith("Reply STOP to opt out.")).toBe(true);
    expect(ABANDON_SMS_BODY.length).toBeLessThanOrEqual(320);
  });
});
