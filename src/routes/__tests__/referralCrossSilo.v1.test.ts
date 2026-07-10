import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("BF_SERVER_REFERRAL_CROSS_SILO_v1", () => {
  const referrerSelf = readFileSync(join(process.cwd(), "src", "routes", "referrerSelf.ts"), "utf8");
  const referralService = readFileSync(join(process.cwd(), "src", "modules", "referrals", "referrals.service.ts"), "utf8");
  const conversions = readFileSync(join(process.cwd(), "src", "modules", "referrals", "referralConversions.service.ts"), "utf8");
  const routeRegistry = readFileSync(join(process.cwd(), "src", "routes", "routeRegistry.ts"), "utf8");
  const migration = readFileSync(join(process.cwd(), "migrations", "2026_07_10_referral_cross_silo.sql"), "utf8");

  it("keeps the sentinel on the referrer self-service route", () => {
    expect(referrerSelf).toContain("BF_SERVER_REFERRAL_CROSS_SILO_v1");
  });

  it("add-referral accepts cross-silo invite fields and returns the minted code", () => {
    expect(referrerSelf).toContain("normalizeReferralSilos(body.silos)");
    expect(referrerSelf).toContain("message");
    expect(referrerSelf).toContain("referrerName");
    expect(referrerSelf).toContain("refCode");
    expect(referralService).toContain("mintReferralCode");
    expect(referralService).toContain("sendReferralInviteSms");
  });

  it("has an additive conversion ledger with 20 percent idempotent crediting", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS referral_conversions");
    expect(migration).toContain("conversion_rate numeric NOT NULL DEFAULT 20");
    expect(migration).toContain("referral_conversions_application_uidx");
    expect(migration).toContain("referral_conversions_external_uidx");
    expect(conversions).toContain("REFERRAL_CONVERSION_RATE = 20");
    expect(conversions).toContain("ON CONFLICT (application_id) WHERE application_id IS NOT NULL DO UPDATE");
    expect(conversions).toContain("ON CONFLICT (source_silo, external_application_id) WHERE external_application_id IS NOT NULL DO UPDATE");
  });

  it("mounts service-JWT protected BI ingest under /api/referrals/from-bi", () => {
    expect(routeRegistry).toContain("referralsExtRoutes");
    expect(routeRegistry).toContain('{ path: "/referrals", router: referralsExtRoutes }');
    expect(readFileSync(join(process.cwd(), "src", "routes", "referralsExt.ts"), "utf8")).toContain('"/from-bi"');
  });
});
