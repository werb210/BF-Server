// BF_SERVER_LENDER_SELF_V2 - source-shape guards:
// 1) phantom lender_products.description (dropped by migration 041) must never
//    reappear in the product SQL (it 500ed every lender-portal product call),
// 2) term/rate-period fields present, 3) the /uploads pair exists and feeds
//    lender_documents + Maya ingest.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(process.cwd(), "src", "routes", "lenderSelf.ts"), "utf-8");
const productsSql = src.slice(src.indexOf('"/products"'));

describe("lenderSelf v2", () => {
  it("does not reference the phantom lender_products.description column", () => {
    expect(productsSql).not.toContain("description");
  });

  it("reads and writes term_min/term_max/rate_period_days", () => {
    for (const col of ["term_min", "term_max", "rate_period_days"]) {
      expect(src).toContain(col);
    }
  });

  it("exposes lender uploads backed by lender_documents + Maya ingest", () => {
    expect(src).toContain('"/uploads"');
    expect(src).toContain("INSERT INTO lender_documents");
    expect(src).toContain("/api/knowledge/ingest");
    expect(src).toContain('upload.single("file")');
  });
});
