// BF_SERVER_v822_CARPLAY - texts and client messages are communication notifications (mutable-content + the sender),
// so the dialler can hand them to Siri / CarPlay. Calls, voicemails and handoffs are unchanged.
import { describe, expect, it } from "vitest";
import { buildStaffAlertPayload, STAFF_ALERT_MESSAGE_CATEGORIES, STAFF_ALERT_SENDER_MAX } from "../staffAlerts.js";

const CONTACT = "11111111-2222-4333-8444-555555555555";

describe("v822 CarPlay message alerts", () => {
  it("marks an inbound text mutable and names the sender", () => {
    const payload = buildStaffAlertPayload({ title: "Jane Client", body: "Can you call me?", category: "SMS", type: "sms",
      data: { contactId: CONTACT, phone: "+14035550144", threadKind: "sms", senderName: "  Jane   Client " } }) as any;
    expect(payload.aps["mutable-content"]).toBe(1);
    expect(payload.senderName).toBe("Jane Client");
    expect(payload.phone).toBe("+14035550144");
    expect(payload.aps["thread-id"]).toBe(`sms:${CONTACT}`);
  });

  it("marks a client-portal message mutable", () => {
    const payload = buildStaffAlertPayload({ title: "Message from Jane", body: "Statements attached", category: "CLIENT_MESSAGE",
      type: "client_message", data: { contactId: CONTACT, threadKind: "messages", senderName: "Jane Client" } }) as any;
    expect(payload.aps["mutable-content"]).toBe(1);
    expect(payload.senderName).toBe("Jane Client");
  });

  it("an unknown texter has no senderName (the app falls back to the number)", () => {
    const payload = buildStaffAlertPayload({ title: "+14035550144", body: "hi", category: "SMS", type: "sms",
      data: { phone: "+14035550144", threadKind: "sms", senderName: null } }) as any;
    expect(payload.aps["mutable-content"]).toBe(1);
    expect("senderName" in payload).toBe(false);
  });

  it("clips a long sender name", () => {
    const payload = buildStaffAlertPayload({ title: "x", body: "y", category: "SMS", type: "sms",
      data: { senderName: "n".repeat(200) } }) as any;
    expect(payload.senderName.length).toBe(STAFF_ALERT_SENDER_MAX);
  });

  it("leaves calls, voicemails and handoffs as ordinary alerts", () => {
    for (const [category, type] of [["MISSED_CALL", "missed_call"], ["VOICEMAIL", "voicemail"], ["HANDOFF", "maya_handoff"]] as const) {
      const payload = buildStaffAlertPayload({ title: "t", body: "b", category, type, data: { senderName: "Jane" } }) as any;
      expect(payload.aps["mutable-content"]).toBeUndefined();
      expect(payload.senderName).toBeUndefined();
    }
    expect([...STAFF_ALERT_MESSAGE_CATEGORIES].sort()).toEqual(["CLIENT_MESSAGE", "SMS"]);
  });
});
