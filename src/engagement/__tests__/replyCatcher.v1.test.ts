// BF_SERVER_ENGAGEMENT_v1
import { describe, expect, it } from "vitest";
import { isOutsideSender, sentTo } from "../replyCatcher.js";
import { digestDue } from "../engagementWorker.js";
import { classifyReply } from "../classifyReply.js";

describe("reply catcher and digest timing", () => {
  it("files only outside senders", () => {
    expect(isOutsideSender("danny@armada.test")).toBe(true);
    expect(isOutsideSender("andrew.p@boreal.financial")).toBe(false);
    expect(isOutsideSender("sales@keystonecrm.online")).toBe(false);
    expect(isOutsideSender("no-reply@vendor.test")).toBe(false);
  });
  it("sends the digest once on weekday mornings in Edmonton", () => {
    const tueMorning = new Date("2026-12-01T14:30:00Z"); // 7:30 Edmonton
    expect(digestDue(tueMorning, null)).toEqual({ due: true, day: "2026-12-01" });
    expect(digestDue(tueMorning, "2026-12-01").due).toBe(false);
    expect(digestDue(new Date("2026-12-01T12:00:00Z"), null).due).toBe(false); // 5am
    expect(digestDue(new Date("2026-12-05T15:00:00Z"), null).due).toBe(false); // Saturday
  });
  it("labels replies the same way as BI", () => {
    expect(classifyReply("RE: x", "What does it cost?")).toBe("question");
  });
  // BF_SERVER_SENT_ITEMS_RESPONDED_v1
  it("a sent message counts as answering its outside recipients only", () => {
    const m = { toRecipients: [{ emailAddress: { address: "Pat@Bank.test" } }, { emailAddress: { address: "andrew.p@boreal.financial" } }],
      ccRecipients: [{ emailAddress: { address: "pat@bank.test" } }, { emailAddress: { address: "ops@lender.test" } }] };
    expect(sentTo(m)).toEqual(["pat@bank.test", "ops@lender.test"]);
  });
});
