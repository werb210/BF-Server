// BF_SERVER_CONTACT_FORM_SPAM_v1
import { describe, expect, it } from "vitest";
import { botReason, isEmailAddress } from "../contactSpam.js";

describe("contact form screening", () => {
  it("knows an email address", () => {
    expect(isEmailAddress("jane@acme.ca")).toBe(true);
    expect(isEmailAddress("jane at acme")).toBe(false);
    expect(isEmailAddress("jane@acme")).toBe(false);
  });
  it("spots the GUID mailbox bot and the hidden field", () => {
    expect(botReason({ email: "9ccccc8a-6b40-4b69-9ae3-5d97b3d1d57c@ssfc01.onmicrosoft.com" })).toBe("guid_mailbox");
    expect(botReason({ email: "jane@acme.ca", website: "http://spam" })).toBe("honeypot");
    expect(botReason({ email: "jane@acme.ca" })).toBeNull();
  });
});
