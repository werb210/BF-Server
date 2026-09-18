// BF_SERVER_CLIENT_CALL_STATUS_GUARD_v353
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("src/routes/webhooks.ts", "utf8");
const branch = src.slice(src.indexOf('if (from.startsWith("client:client-")) {'));

describe("a Call Us! end-of-call callback is not a new call", () => {
  it("returns empty TwiML before any conference is created", () => {
    const guard = branch.indexOf("BF_SERVER_CLIENT_CALL_STATUS_GUARD_v353");
    const create = branch.indexOf("createConference({");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(create);
    expect(branch).toContain('req.body?.CallbackSource || ["completed", "canceled", "busy", "failed", "no-answer"].includes(clientCallStatus)');
    expect(branch).toContain('return res.send("<Response/>");');
  });
});
