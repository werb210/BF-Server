// BF_SERVER_REFERRER_PAYOUT_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(path.join(process.cwd(), "src/routes/adminReferrers.ts"), "utf8");
const mig = readFileSync(path.join(process.cwd(), "migrations/2026_07_11_referral_conversions_paid_at.sql"), "utf8");

describe("referrer payout", () => {
  it("migration adds paid_at idempotently", () => {
    expect(mig).toContain("ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ");
  });

  it("admin-only pay route flips credited -> paid and stamps paid_at", () => {
    expect(src).toContain('router.post("/:id/pay"');
    expect(src).toContain("requireAuthorization({ roles: [ROLES.ADMIN] })");
    expect(src).toContain("SET status = 'paid', paid_at = now()");
    expect(src).toContain("WHERE referrer_id::text = $1 AND status = 'credited'");
  });
});
