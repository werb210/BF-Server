// BF_SERVER_OWNER1_SIGNING_SMS_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const session = readFileSync(
  path.join(process.cwd(), "src/signnow/embeddedSigningSession.ts"),
  "utf8",
);

describe("owner 1 is notified when a signing envelope is created", () => {
  it("sends an SMS to the applicant", () => {
    expect(session).toContain("BF_SERVER_OWNER1_SIGNING_SMS_v1");
    expect(session).toContain("modules/notifications/sms.service.js");
    expect(session).toContain("sendSms(");
  });

  it("points the applicant at the portal, not a 45-minute embedded link", () => {
    // Embedded links are hard-capped at 45 min (19019003); the portal re-mints one
    // on every load, so the SMS must carry the portal address.
    expect(session).toContain("client.boreal.financial");
    expect(session).not.toContain("message: `${greeting} sign here: ${link.url}");
  });

  it("carries CASL-required opt-out wording", () => {
    expect(session).toContain("Reply STOP to opt out");
  });

  it("records when the SMS was sent", () => {
    expect(session).toContain("owner1_signing_sms_at");
  });

  it("never blocks envelope creation on a notification failure", () => {
    expect(session).toContain("Owner 1 signing SMS failed for app=");
  });

  it("skips cleanly when the applicant has no usable phone", () => {
    expect(session).toContain("no usable phone for app=");
  });
});
