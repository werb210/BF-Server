// BF_SERVER_UNDER_10K_WAITLIST_v735
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
describe("waitlist lists and consent", () => {
  const s = readFileSync("src/routes/crm.ts", "utf8");
  it("tags the under-$10k list separately from start-ups", () => {
    expect(s).toContain('=== "under_10k" ? "under_10k_revenue_waitlist" : "startup_waitlist"');
  });
  it("records express consent only when the box was ticked", () => {
    expect(s).toContain("const consent = req.body?.consent === true;");
    expect(s).toContain("consent_basis  = CASE WHEN $3 THEN 'express' ELSE consent_basis END,");
  });
});
