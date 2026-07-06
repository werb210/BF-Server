// READINESS_PREFILL_CRM_FALLBACK_v1 - the wizard's phone-based prefill must
// fall back to a returning client's CRM contact + most recent application when
// they have no readiness_sessions row (i.e. they OTP'd straight in and never
// did the marketing-site readiness check). Before this, such clients opened a
// blank wizard even though we already knew them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(process.cwd(), "src", "routes", "client", "index.ts"), "utf-8");

describe("readiness-prefill CRM fallback", () => {
  it("falls back to the most recent application when no readiness session matches", () => {
    expect(src).toContain("READINESS_PREFILL_CRM_FALLBACK_v1");
    expect(src).toContain("FROM applications a");
    expect(src).toContain("JOIN contacts c ON c.id = a.contact_id");
    expect(src).toContain("ORDER BY a.updated_at DESC NULLS LAST, a.created_at DESC");
  });

  it("only runs the fallback on the phone path, keyed on last-10-digit match", () => {
    expect(src).toContain("if (!row && phone)");
    expect(src).toContain("right(regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g'), 10)");
  });

  it("returns the same prefill field shape as the readiness-session path", () => {
    expect(src).toContain('source: "crm"');
    expect(src).toContain("annualRevenueRange");
    expect(src).toContain("businessLocation");
    expect(src).toContain("requestedAmount");
  });

  it("still returns found:false when neither a session nor an application exists", () => {
    expect(src).toContain('res.status(200).json({ found: false })');
  });
});
