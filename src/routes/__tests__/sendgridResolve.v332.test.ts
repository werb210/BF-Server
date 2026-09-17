// BF_SERVER_SENDGRID_RESOLVE_v332
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const hook = readFileSync(resolve(__dirname, "..", "sendgridWebhook.ts"), "utf-8");

describe("an email event finds its contact", () => {
  it("matches secondary email", () => expect(hook).toContain("lower(trim(coalesce(secondary_email, ''))) = $1"));
  it("trims stored primary email", () => expect(hook).toContain("lower(trim(coalesce(email, ''))) = $1"));
  it("prefers the primary address", () => expect(hook).toContain("ORDER BY (lower(trim(coalesce(email, ''))) = $1) DESC, created_at"));
  it("trusts contact_id first", () => expect(hook).toContain("const contactId = ev?.contact_id ? String(ev.contact_id) : null;"));
});

describe("an unresolved event is visible", () => {
  it("counts and names failed addresses", () => {
    expect(hook).toContain("contactsUnresolved: unresolvedEmails.size,");
    expect(hook).toContain("unresolvedSample:");
  });
  it("caps the sample", () => expect(hook).toContain("Array.from(unresolvedEmails).slice(0, 5)"));
  it("still skips the event", () => {
    expect(hook).toContain("if (email) unresolvedEmails.add(email);");
    expect(hook).toContain("continue;");
  });
});
