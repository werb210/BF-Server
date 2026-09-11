import { describe, it, expect } from "vitest";
import { buildFcmMessage, toDataStrings } from "../fcmMessage.js";

describe("BF_SERVER_FCM_DATA_ONLY_v157", () => {
  it("sends no notification block, which is what forced tray rendering", () => {
    const msg = buildFcmMessage("tok", { title: "T", body: "B" });
    expect("notification" in msg.message).toBe(false);
    expect("notification" in msg.message.android).toBe(false);
  });

  it("carries the title and body in data so the client can render them", () => {
    const msg = buildFcmMessage("tok", { title: "Document required", body: "March statement" });
    expect(msg.message.data.title).toBe("Document required");
    expect(msg.message.data.body).toBe("March statement");
  });

  it("keeps the category so the client knows which actions to attach", () => {
    const msg = buildFcmMessage("tok", {
      title: "T", body: "B",
      data: { categoryId: "DOCUMENT_REQUEST", deepLink: "/applications/a1/documents" },
    });
    expect(msg.message.data.categoryId).toBe("DOCUMENT_REQUEST");
    expect(msg.message.data.deepLink).toBe("/applications/a1/documents");
  });

  it("defaults the category rather than leaving the client to guess", () => {
    expect(buildFcmMessage("tok", { title: "T", body: "B" }).message.data.categoryId).toBe("GENERIC");
  });

  it("sends at high priority so a backgrounded app is still woken", () => {
    expect(buildFcmMessage("tok", { title: "T", body: "B" }).message.android.priority).toBe("high");
  });

  it("serialises non-string data values, which FCM rejects", () => {
    const out = toDataStrings({ count: 3, flag: true, nested: { a: 1 }, text: "keep" });
    expect(out.count).toBe("3");
    expect(out.flag).toBe("true");
    expect(out.nested).toBe('{"a":1}');
    expect(out.text).toBe("keep");
  });

  it("drops null and undefined rather than sending the strings null or undefined", () => {
    const out = toDataStrings({ a: null, b: undefined, c: "ok" });
    expect(out).toEqual({ c: "ok" });
  });

  it("puts the token on the message", () => {
    expect(buildFcmMessage("abc123", { title: "T", body: "B" }).message.token).toBe("abc123");
  });

  it("tolerates a missing title or body without emitting undefined", () => {
    const msg = buildFcmMessage("tok", { title: "", body: "" });
    expect(msg.message.data.title).toBe("");
    expect(msg.message.data.body).toBe("");
  });

  it("never lets caller data overwrite the rendered title", () => {
    const msg = buildFcmMessage("tok", { title: "Real", body: "B", data: { title: "Spoof" } });
    expect(msg.message.data.title).toBe("Real");
  });
});
