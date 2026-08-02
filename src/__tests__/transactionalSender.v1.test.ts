import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const service = readFileSync(fileURLToPath(new URL("../services/sendgridService.ts", import.meta.url)), "utf-8");
const invite = readFileSync(fileURLToPath(new URL("../services/accountantInvite.ts", import.meta.url)), "utf-8");

describe("transactional SendGrid sender v1", () => {
  it("disables click, open, and subscription tracking without an unsubscribe group", () => {
    const start = service.indexOf("export async function sendTransactional");
    const end = service.indexOf("export async function sendOne", start);
    const implementation = service.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(implementation).toContain("click_tracking: { enable: false, enable_text: false }");
    expect(implementation).toContain("open_tracking: { enable: false }");
    expect(implementation).toContain("subscription_tracking: { enable: false }");
    expect(implementation).not.toContain("SENDGRID_UNSUBSCRIBE_GROUP_ID");
    expect(implementation).not.toMatch(/\basm\b/);
  });

  it("leaves the marketing sender tracking and unsubscribe behavior intact", () => {
    const start = service.indexOf("export async function sendOne");
    const implementation = service.slice(start);

    expect(implementation).toContain("SENDGRID_UNSUBSCRIBE_GROUP_ID");
    expect(implementation).toContain("click_tracking: { enable: true }");
    expect(implementation).toContain("open_tracking: { enable: true }");
  });

  // BF_SERVER_EMAIL_CHANNEL_TESTS_v2 - one-to-one operational mail goes through
  // the tenant mailbox, not the ESP. Assert the channel that is actually in use;
  // asserting the retired one turned a correct migration into a red build.
  it("routes accountant invitations through Microsoft Graph, not SendGrid", () => {
    expect(invite).toContain("sendViaGraph");
    expect(invite).toContain("await sendViaGraph({");
    expect(invite).not.toContain("await sendTransactional({");
    expect(invite).not.toContain("await sendOne({");
  });
});
