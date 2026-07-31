import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const capture = readFileSync(
  fileURLToPath(new URL("../routes/client/accountant.ts", import.meta.url)),
  "utf-8",
);
const auth = readFileSync(fileURLToPath(new URL("../routes/auth.ts", import.meta.url)), "utf-8");
const contacts = readFileSync(fileURLToPath(new URL("../services/contacts.ts", import.meta.url)), "utf-8");

describe("BF_SERVER_ACCOUNTANT_CONTACT_PHONE_v1", () => {
  it("writes the captured phone so OTP sign-in can match it", () => {
    expect(capture).toContain("phone = COALESCE(NULLIF($3, ''), phone)");
  });

  it("writes the captured email too", () => {
    expect(capture).toContain("email = COALESCE(NULLIF($4, ''), email)");
  });

  it("passes the captured values, not just the tag", () => {
    expect(capture).toContain("[crmContact.id, [ROLE_TAG], phone, email]");
  });

  it("still applies the tag the OTP branch matches on", () => {
    expect(capture).toContain("ROLE_TAG");
    expect(capture).toContain('"Accountant/advisor"');
  });

  it("guards the reason this was needed: find-or-create does not write the phone", () => {
    // If this assertion ever fails, find-or-create has started updating the row
    // and the COALESCE above may be redundant - worth rechecking rather than
    // assuming.
    expect(contacts).toContain("if (idMatch[0]) {");
    expect(contacts).toContain("return { row: idMatch[0], created: false };");
  });

  it("matches the column the OTP branch reads", () => {
    expect(auth).toContain("right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)");
  });
});
