// BF_SERVER_SBA_V103
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const R = (...p: string[]) => readFileSync(resolve(__dirname, ...p), "utf-8");
const signing = R("..", "sbaSigning.ts");
const route = R("..", "..", "..", "routes", "lenderProductsRequiredDocs.ts");
const mig = R("..", "..", "..", "..", "migrations", "2026_08_26_v103_sba_docs_into_product_json.sql");

const SBA_KEYS = [
  "sba_form_413", "sba_form_1919", "owner_photo_id", "formation_documents",
  "personal_tax_returns", "business_plan", "sba_1919_attachments",
  "debt_schedule", "lease_or_loi",
];

describe("Stage 2 reachability", () => {
  it("mirrors the SBA set into the jsonb column the route reads", () => {
    for (const k of SBA_KEYS) expect(mig).toContain(k);
    expect(mig).toContain("required_documents");
  });
  it("merges BEFORE the row is written", () => {
    expect(mig).toContain("BEFORE INSERT OR UPDATE OF type ON lender_products");
  });
  it("is idempotent across both field spellings", () => {
    expect(mig).toContain("h->>'document_type', h->>'category'");
  });
  it("expands Form 413 per owner", () => {
    expect(route).toContain("sba_form_413_owner_${o.index}");
    expect(route).toContain("resolveSbaOwners");
    expect(route).toContain("if (o.index <= 1) continue;");
  });
});

describe("dispatch gate", () => {
  it("answers to the owner list, not the envelope list", () => {
    expect(signing).toContain("resolveSbaOwners(applicationId)");
    expect(signing).toContain("sba_dispatch_blocked_missing_envelope");
  });
  it("no longer passes an empty envelope list", () => {
    const fn = signing.slice(signing.indexOf("export async function sbaSigningSatisfiedForDispatch"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).not.toContain("if (envelopes.length === 0) return true;");
  });
  it("refuses dispatch when no owners resolve", () => {
    expect(signing).toContain("if (owners.length === 0) return false;");
  });
  it("keeps the unconfigured-SignNow escape so non-prod is unaffected", () => {
    expect(signing).toContain("if (!isApiKeyConfigured()) return true;");
  });
  it("logs rather than silently thinning the package", () => {
    expect(signing).toContain("sba_signed_pdfs_none_available");
  });
});
