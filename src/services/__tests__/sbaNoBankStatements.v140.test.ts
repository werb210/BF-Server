// BF_SERVER_SBA_NO_BANK_STATEMENTS_v140
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { alwaysRequiredFor, ALWAYS_REQUIRED_DOCUMENTS } from "../../db/schema/requiredDocuments.js";

const svc = readFileSync(resolve(__dirname, "..", "lenderProductRequirementsService.ts"), "utf-8");
const mig = readFileSync(
  resolve(__dirname, "..", "..", "..", "migrations", "2026_08_29_v140_sba_drop_bank_statements.sql"), "utf-8");

describe("SBA does not ask for bank statements", () => {
  it("exempts them for SBA", () => {
    expect(alwaysRequiredFor("SBA")).not.toContain("bank_statements_6_months");
  });

  it.each(["LOC", "TERM", "FACTORING", "EQUIPMENT", "MCA", "ABL"])(
    "still requires them for %s",
    (category) => {
      expect(alwaysRequiredFor(category)).toContain("bank_statements_6_months");
    },
  );

  it("is case-insensitive, because callers pass whatever they have", () => {
    expect(alwaysRequiredFor("sba")).not.toContain("bank_statements_6_months");
    expect(alwaysRequiredFor(" Sba ")).not.toContain("bank_statements_6_months");
  });

  it("an unknown or absent category gets the full list - fail toward asking", () => {
    expect(alwaysRequiredFor(null)).toEqual(ALWAYS_REQUIRED_DOCUMENTS);
    expect(alwaysRequiredFor("SOMETHING_NEW")).toEqual(ALWAYS_REQUIRED_DOCUMENTS);
  });
});

describe("every resolver passes its category through", () => {
  it("no call site drops it", () => {
    // Only actual invocations - the definition on its own line is not one.
    const calls = (svc.match(/^ *(?:const \w+ =|return|.*= )?\s*ensureAlwaysRequired\(.*\);?$/gm) ?? [])
      .filter((l) => !l.includes("function"));
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) {
      expect(call).toMatch(/,\s*(category|product\.category)\)/);
    }
  });

  it("uses the category-aware helper, not the raw list", () => {
    expect(svc).toContain("alwaysRequiredFor(category)");
  });
});

describe("files already stuck are cleared", () => {
  // BF_SERVER_V140_MIGRATION_FIX_v143 - the first cut of this migration took the
  // server down: it referenced a table no migration creates. Application code
  // swallows that with .catch(); startup migrations fail closed.
  it("does not reference document_requirements", () => {
    expect(mig).not.toContain("DELETE FROM document_requirements");
  });

  it("touches only relations that migrations actually create", () => {
    const targets = [...mig.matchAll(/^\s*(?:UPDATE|DELETE FROM|INSERT INTO)\s+(\w+)/gim)].map((m) => m[1]);
    expect(targets).toEqual(["lender_products"]);
  });

  it("uses no plpgsql, so the suite can execute it", () => {
    expect(mig).not.toContain("DO $$");
  });

  it("only touches SBA products", () => {
    // BF_SERVER_V140_MIGRATION_FIX_v143 - the aliased form belonged to the
    // DELETE that has been removed; the UPDATE has no alias.
    expect(mig).toContain("upper(COALESCE(category, '')) = 'SBA'");
  });

  it("also strips it from the product JSON so the fallback cannot re-add it", () => {
    expect(mig).toContain("UPDATE lender_products");
    expect(mig).toContain("jsonb_array_elements(required_documents)");
  });

  it("does not use pg_trgm", () => {
    expect(mig).not.toContain("pg_trgm");
  });
});
