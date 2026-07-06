// BF_SERVER_REFERRER_SELF_v1 / BF_SERVER_REFERRER_OTP_v1 - referrer portal
// backend: OTP login mints a referrer-bound token, and the self-service routes
// are gated to the Referrer role and scoped to the token's referrerId.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const referrer = readFileSync(join(process.cwd(), "src", "routes", "referrerSelf.ts"), "utf8");
const auth = readFileSync(join(process.cwd(), "src", "routes", "auth.ts"), "utf8");
const registry = readFileSync(join(process.cwd(), "src", "routes", "routeRegistry.ts"), "utf8");

describe("referrer route mount", () => {
  it("is registered under /referrer (=> /api/referrer/*)", () => {
    expect(registry).toContain("referrerSelfRoutes");
    expect(registry).toContain('{ path: "/referrer", router: referrerSelfRoutes }');
  });
});

describe("referrer self-service routes", () => {
  it("exposes pipeline, add-referral, profile and me", () => {
    expect(referrer).toContain('"/pipeline"');
    expect(referrer).toContain('"/add-referral"');
    expect(referrer).toContain('"/profile"');
    expect(referrer).toContain('"/me"');
  });

  it("gates every route to the Referrer role and scopes to referrerId", () => {
    expect(referrer).toContain("requireReferrer");
    expect(referrer).toContain("referrer_role_required");
    expect(referrer).toContain("c.referrer_id::text = $1");
  });

  it("pipeline is BF-silo-scoped and joins application stage", () => {
    expect(referrer).toContain("c.silo = 'BF'");
    expect(referrer).toContain("a.pipeline_state AS application_stage");
  });

  it("add-referral reuses the canonical submitReferral service", () => {
    expect(referrer).toContain("submitReferral");
    expect(referrer).toContain("name_and_phone_required");
  });
});

describe("referrer OTP login", () => {
  it("mints a referrer-bound token for a Referrer user matched by phone", () => {
    expect(auth).toContain("BF_SERVER_REFERRER_OTP_v1");
    expect(auth).toContain('userType ?? "") === "referrer"');
    expect(auth).toContain("referrerId: String(referrer.id)");
    expect(auth).toContain("role: ROLES.REFERRER");
  });

  it("refuses no-match and ambiguous shared phones", () => {
    expect(auth).toContain("no_referrer_for_phone");
    expect(auth).toContain("ambiguous_referrer_phone");
  });
});
