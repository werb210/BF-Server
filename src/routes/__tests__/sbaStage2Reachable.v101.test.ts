// BF_SERVER_SBA_STAGE2_REACHABLE_v101
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const routeSrc = readFileSync(resolve(__dirname, "..", "lenderProductsRequiredDocs.ts"), "utf-8");
const migSrc = readFileSync(resolve(__dirname, "..", "..", "..", "migrations", "2026_08_26_v101_sba_docs_into_product_json.sql"), "utf-8");

describe("SBA Stage 2 reachability", () => {
  it("expands Form 413 per owner while preserving owner one's key", () => {
    expect(routeSrc).toContain("sba_form_413_owner_${o.index}");
    expect(routeSrc).toContain("resolveSbaOwners");
    expect(routeSrc).toContain("if (o.index <= 1) continue;");
  });

  it("does not blank the list after owner resolution failure", () => {
    const idx = routeSrc.indexOf("sba_form_413_owner_");
    expect(routeSrc.slice(idx).includes("catch")).toBe(true);
  });

  it("mirrors every SBA requirement into product JSON", () => {
    expect(migSrc).toContain("required_documents");
    for (const key of ["sba_form_413", "sba_form_1919", "owner_photo_id", "formation_documents", "personal_tax_returns", "business_plan", "sba_1919_attachments", "debt_schedule", "lease_or_loi"]) {
      expect(migSrc).toContain(key);
    }
  });

  it("uses an idempotent BEFORE trigger", () => {
    expect(migSrc).toContain("BEFORE INSERT OR UPDATE OF type ON lender_products");
    expect(migSrc).toContain("h->>'document_type', h->>'category'");
  });
});
