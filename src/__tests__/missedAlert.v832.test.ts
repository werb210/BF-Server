// BF_SERVER_v832_DIALER_SIGNOUT_ALERTS - a missed-call alert reaches the dialler's notification extension
// (mutable-content), which removes the phone's own "Missed call" for the same caller, so it shows once.
import { describe, expect, it } from "vitest";
import { buildStaffAlertPayload } from "../services/notifications/staffAlerts.js";

describe("missed-call alert payload", () => {
  it("is mutable and carries the caller's number for matching", () => {
    const payload = buildStaffAlertPayload({ title: "Missed call", body: "Jane", category: "MISSED_CALL", type: "missed_call",
      data: { phone: "+14035550144" } }) as any;
    expect(payload.aps["mutable-content"]).toBe(1);
    expect(payload.type).toBe("missed_call");
    expect(payload.phone).toBe("+14035550144");
  });

  it("other call alerts stay as they were", () => {
    const voicemail = buildStaffAlertPayload({ title: "Voicemail", body: "b", category: "VOICEMAIL", type: "voicemail" }) as any;
    expect(voicemail.aps["mutable-content"]).toBeUndefined();
  });
});
