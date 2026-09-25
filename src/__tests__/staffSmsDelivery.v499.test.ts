// BF_SERVER_BLOCK_v499_STAFF_SMS_DELIVERY_STATUS
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../routes/communications.ts", import.meta.url)), "utf-8");

describe("v499 staff SMS delivery status", () => {
  it("asks Twilio for delivery updates and records the send", () => {
    expect(src).toContain("to: String(to), statusCallback,");
    expect(src).toContain("VALUES ($1, $2, 'staff_sms', $3, $4) ON CONFLICT (message_sid) DO NOTHING");
  });
  it("the thread returns delivery status and error code", () => {
    expect(src).toContain("AS delivery_status,");
    expect(src).toContain("AS delivery_error");
  });
});
