// BF_SERVER_CONTACT_FORM_AUTOMATION_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const s = readFileSync(path.join(process.cwd(), "src/modules/website/contact.controller.ts"), "utf8");
describe("contact form automation v1", () => {
  it("tags the contact 'Contact form'", () => {
    expect(s).toContain("ARRAY['Contact form']");
    expect(s).toContain("UPDATE contacts");
  });
  // BF_SERVER_EMAIL_CHANNEL_TESTS_v2 - the autoresponder is one-to-one
  // operational mail and runs on sendTransactional, which disables click/open
  // tracking and carries no unsubscribe group. sendOne is the marketing sender.
  it("auto-sends the BF-After contact form template", () => {
    expect(s).toContain('"BF-After contact form"');
    expect(s).toContain("sendTransactional(");
    expect(s).not.toContain("sendOne(");
    expect(s).toContain("mergeFields(");
  });
  it("notification deep-links to the contact record", () => {
    expect(s).toContain("`/crm/contacts/${encodeURIComponent(contactId)}`");
  });
});
