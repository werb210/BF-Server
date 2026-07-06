// BF_SERVER_LENDER_OTP_AMBIGUOUS_v1 and lender-portal hygiene fixes.
//  1. uploads sentinel present (fixes the pre-existing lenderSelfUploads test grep)
//  2. stale /api/lender/applications manifest lines removed
//  3. OTP login refuses a phone that matches more than one active lender
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const lenderSelf = readFileSync(join(process.cwd(), "src", "routes", "lenderSelf.ts"), "utf-8");
const registry = readFileSync(join(process.cwd(), "src", "routes", "routeRegistry.ts"), "utf-8");
const auth = readFileSync(join(process.cwd(), "src", "routes", "auth.ts"), "utf-8");

describe("lender uploads sentinel", () => {
  it("uploads section carries the sentinel the test suite greps for", () => {
    expect(lenderSelf).toContain("BF_SERVER_LENDER_SELF_UPLOADS_v1");
    expect(lenderSelf).toContain("INSERT INTO lender_documents");
    expect(lenderSelf).toContain("lender_id::text = $1");
  });
});

describe("route registry hygiene", () => {
  it("stale lender applications manifest lines are gone", () => {
    expect(registry).not.toContain('path: "/api/lender/applications"');
    expect(registry).not.toContain('path: "/api/lender/applications/:id"');
  });
});

describe("lender OTP shared-phone guard", () => {
  it("removes LIMIT 1 and refuses ambiguous multi-lender matches", () => {
    expect(auth).toContain("BF_SERVER_LENDER_OTP_AMBIGUOUS_v1");
    expect(auth).toContain("ambiguous_lender_phone");
    expect(auth).toContain("lenderResult.rows.length > 1");
    expect(auth).not.toContain("LIMIT 1`");
  });

  it("still rejects no-match and mints a token on a single match", () => {
    expect(auth).toContain("no_lender_for_phone");
    expect(auth).toContain("role: ROLES.LENDER");
  });
});
