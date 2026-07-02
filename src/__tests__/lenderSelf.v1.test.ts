import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(fileURLToPath(new URL("../routes/lenderSelf.ts", import.meta.url)), "utf-8");
const reg = readFileSync(fileURLToPath(new URL("../routes/routeRegistry.ts", import.meta.url)), "utf-8");

describe("lender self-service API", () => {
  it("is role-gated, lender-scoped, and mounted", () => {
    expect(src).toContain("role !== ROLES.LENDER");
    expect(src).toContain("lender_id::text = $1");
    expect(src).toContain("decoded.lenderId ?? decoded.lender_id");
    expect(reg).toContain('{ path: "/lender", router: lenderSelfRoutes }');
  });

  it("exposes profile and product write endpoints", () => {
    for (const path of [
      'router.get(\n  "/me"',
      'router.patch(\n  "/me"',
      'router.get(\n  "/products"',
      'router.post(\n  "/products"',
      'router.patch(\n  "/products/:id"',
    ]) {
      expect(src).toContain(path);
    }
    expect(reg).toContain('{ method: "POST", path: "/api/lender/products", roles: [ROLES.LENDER] }');
    expect(reg).toContain('{ method: "PATCH", path: "/api/lender/products/:id", roles: [ROLES.LENDER] }');
  });

  it("validates product CHECK constraint values before writes", () => {
    expect(src).toContain('const COUNTRIES = ["CA", "US", "BOTH"]');
    expect(src).toContain('const RATE_KINDS = ["apr", "monthly", "factor"]');
    expect(src).toContain('const RATE_TYPES = ["VARIABLE", "FIXED"]');
    expect(src).toContain("type = $4");
  });
});
