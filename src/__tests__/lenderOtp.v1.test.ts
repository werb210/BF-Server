// BF_SERVER_LENDER_OTP_v1 - /api/auth/otp/verify must have a lender branch:
// userType:"lender" + Twilio-approved code -> match lenders.contact_phone
// (digit-normalized, active BF, most recently updated wins) -> mint a
// Lender-role token carrying lenderId. Without this no lender token can
// ever exist and every /api/lender/* call 403s with lender_role_required.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const auth = readFileSync(join(process.cwd(), "src", "routes", "auth.ts"), "utf-8");
const jwtSrc = readFileSync(join(process.cwd(), "src", "auth", "jwt.ts"), "utf-8");

describe("lender OTP branch", () => {
  it("honors userType lender on verify and binds lenderId", () => {
    expect(auth).toContain('=== "lender"');
    expect(auth).toContain("role: ROLES.LENDER");
    expect(auth).toContain("lenderId: String(lender.id)");
  });
  it("matches lenders.contact_phone digit-normalized, active BF, latest updated wins", () => {
    expect(auth).toContain("FROM lenders");
    expect(auth).toContain("contact_phone");
    expect(auth).toContain("ORDER BY updated_at DESC");
    // BF_SERVER_LENDER_OTP_PHONE_COLUMNS_v2 - staff form writes primary_contact_phone
    expect(auth).toContain("primary_contact_phone");
    expect(auth).toContain("silo = 'BF'");
  });
  it("refuses with no_lender_for_phone instead of minting a client token", () => {
    expect(auth).toContain("no_lender_for_phone");
  });
  it("AccessTokenPayload carries the lenderId claim", () => {
    expect(jwtSrc).toContain("lenderId?: string;");
  });
});
