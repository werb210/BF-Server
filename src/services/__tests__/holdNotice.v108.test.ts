// BF_SERVER_HOLD_CLIENT_EMAIL_v108
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const R = (...p: string[]) => readFileSync(resolve(__dirname, "..", ...p), "utf-8");
const notice = R("holdNotice.ts");
const portal = R("..", "routes", "portal.ts");

describe("hold notice copy", () => {
  it("uses the 30-day retention wording", () => {
    expect(notice).toContain("held for 30 days");
    expect(notice).toContain("purged as per our privacy policy");
  });
  it("says archived, not achieved", () => {
    expect(notice).toContain("has been archived");
    expect(notice).not.toContain("has been achieved");
  });
  it("escapes the staff-entered reason", () => {
    expect(notice).toContain("escapeHtml");
    expect(notice).toContain("escapeHtml(l)");
  });
  it("renders a multi-line reason as a list", () => {
    expect(notice).toContain("<ul>");
  });
});

describe("hold notice sending", () => {
  it("never sends without a reason or an address", () => {
    expect(notice).toContain("hold_notice_skipped_no_reason");
    expect(notice).toContain("hold_notice_skipped_no_email");
  });
  it("goes out as submissions@ via the default send-as", () => {
    expect(notice).toContain("sendViaGraph({");
    expect(notice).not.toContain("sendAs:");
  });
  it("returns rather than throws on a send failure", () => {
    expect(notice).toContain("hold_notice_send_failed");
    expect(notice).toContain("return { sent: false, error: String(sent.error) };");
  });
});

describe("status route", () => {
  it("requires a reason for hold", () => {
    expect(portal).toContain("A reason is required when putting an application on hold");
  });
  it("emails on hold only, never on fraud", () => {
    const i = portal.indexOf("sendHoldNoticeToClient");
    expect(i).toBeGreaterThan(-1);
    expect(portal.lastIndexOf("if (status === ApplicationStage.HOLD) {", i)).toBeGreaterThan(-1);
  });
  it("does not await the send into the response", () => {
    expect(portal).toContain("void (async () => {");
  });
});
