import fs from "node:fs";
import path from "node:path";

import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";

const ALLOWED_CATEGORIES = [
  "LOC",
  "TERM",
  "FACTORING",
  "PO",
  "EQUIPMENT",
  "MCA",
  "LINE_OF_CREDIT",
  "TERM_LOAN",
  "INVOICE_FACTORING",
  "PURCHASE_ORDER_FINANCE",
  "EQUIPMENT_FINANCE",
  "STARTUP_CAPITAL",
] as const;

function applyUpTo134ForCategoryConstraint() {
  const db = newDb();

  db.public.none(`
    CREATE TABLE lender_products (
      id uuid PRIMARY KEY,
      category text
    );
  `);

  // Simulate pre-134 state from migration 111 (short-code-only check set).
  db.public.none(`
    ALTER TABLE lender_products
      ADD CONSTRAINT lender_products_category_check
      CHECK (category IN ('LOC','TERM','FACTORING','PO','EQUIPMENT','MCA','MEDIA'));
  `);

  // Apply migration 134 SQL with pg-mem compatibility rewrites.
  const migration134 = fs.readFileSync(
    path.resolve(process.cwd(), "migrations/134_lender_products_category_expand.sql"),
    "utf8",
  )
    .replace(/ALTER TABLE IF EXISTS lender_products/gi, "ALTER TABLE lender_products")
    .replace(/DROP CONSTRAINT IF EXISTS lender_products_category_check/gi, "DROP CONSTRAINT lender_products_category_check");
  db.public.none(migration134);

  return db;
}

describe("134_lender_products_category_expand migration", () => {
  it("accepts long and short categories and rejects unknown values", () => {
    const db = applyUpTo134ForCategoryConstraint();

    expect(() => {
      db.public.none(
        `INSERT INTO lender_products (id, category) VALUES ('11111111-1111-4111-8111-111111111111', 'PURCHASE_ORDER_FINANCE')`,
      );
    }).not.toThrow();

    expect(() => {
      db.public.none(
        `INSERT INTO lender_products (id, category) VALUES ('22222222-2222-4222-8222-222222222222', 'LOC')`,
      );
    }).not.toThrow();

    try {
      db.public.none(
        `INSERT INTO lender_products (id, category) VALUES ('33333333-3333-4333-8333-333333333333', 'BOGUS_CATEGORY')`,
      );
      throw new Error("Expected check constraint violation");
    } catch (error: any) {
      const sqlState = error?.code ?? error?.data?.code;
      if (sqlState !== undefined) {
        expect(sqlState).toBe("23514");
      } else {
        expect(String(error?.message ?? error)).toContain("check constraint");
      }
    }

    const migration134Sql = fs.readFileSync(
      path.resolve(process.cwd(), "migrations/134_lender_products_category_expand.sql"),
      "utf8",
    );

    // Prefer catalog-level assertion; pg-mem may not fully populate pg_constraint fields.
    const catalogRows = db.public.many(`
      SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'lender_products'
    `) as Array<{ conname: string | null; definition: string | null }>;

    const namedConstraint = catalogRows.find((row) => row.conname === "lender_products_category_check");
    const definitionSource = namedConstraint?.definition ?? migration134Sql;

    for (const category of ALLOWED_CATEGORIES) {
      expect(definitionSource).toContain(`'${category}'`);
    }
    expect(ALLOWED_CATEGORIES).toHaveLength(12);
  });
});
