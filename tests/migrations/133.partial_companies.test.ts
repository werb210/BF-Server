import fs from "node:fs";
import path from "node:path";

import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";

const EXPECTED_COMPANY_COLUMNS = [
  "id",
  "name",
  "website",
  "city",
  "province",
  "country",
  "industry",
  "annual_revenue",
  "number_of_employees",
  "silo",
  "owner_id",
  "created_at",
];

function runMigrationsUpTo133WithPartialCompanies() {
  const db = newDb();
  db.public.registerFunction({
    name: "gen_random_uuid",
    returns: "uuid" as any,
    implementation: () => "11111111-1111-4111-8111-111111111111",
  });

  db.public.none("CREATE TABLE schema_migrations (id text PRIMARY KEY);");
  db.public.none("CREATE TABLE users (id uuid PRIMARY KEY);");
  db.public.none("CREATE TABLE contacts (id uuid PRIMARY KEY);");
  db.public.none("CREATE TABLE lender_products (id uuid PRIMARY KEY, status text);");
  db.public.none("CREATE TABLE lenders (id uuid PRIMARY KEY, submission_method text, active boolean, status text);");

  db.public.none("CREATE TABLE companies (id uuid PRIMARY KEY);");

  const migrationPath = path.resolve(process.cwd(), "migrations/133_recovery_columns_v2.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");
  const withoutDoBlocks = sql.replace(/DO \$\$[\s\S]*?END \$\$;/g, "").trim();
  const pgMemSafeSql = withoutDoBlocks
    .replace(/CREATE TABLE IF NOT EXISTS companies[\s\S]*?\);\n\n/i, "")
    .replace(/DEFAULT\s+gen_random_uuid\(\)/gi, "");

  db.public.none("UPDATE lender_products SET status = 'active' WHERE status IS NULL;");
  db.public.none("ALTER TABLE lender_products ALTER COLUMN status SET DEFAULT 'active';");
  db.public.none(pgMemSafeSql);
  db.public.none("INSERT INTO schema_migrations (id) VALUES ('133_recovery_columns_v2.sql');");

  return db;
}

describe("133 migration on partial companies table", () => {
  it("repairs companies schema/indexes/fk/checks without over-registering migrations", () => {
    const db = runMigrationsUpTo133WithPartialCompanies();

    const companyColumns = db.public
      .many("SELECT column_name FROM information_schema.columns WHERE table_name = 'companies'")
      .map((row: any) => row.column_name);
    expect(companyColumns).toEqual(expect.arrayContaining(EXPECTED_COMPANY_COLUMNS));

    expect(() => db.public.none("CREATE INDEX companies_silo_idx ON companies(silo)"))
      .toThrow();
    expect(() => db.public.none("CREATE INDEX companies_owner_idx ON companies(owner_id)"))
      .toThrow();

    expect(() => db.public.none("INSERT INTO companies (id, name, owner_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Acme', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')"))
      .toThrow();

    db.public.none("INSERT INTO lenders (id, submission_method) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'EMAIL')");
    db.public.none("INSERT INTO lenders (id, submission_method) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'API')");
    db.public.none("INSERT INTO lenders (id, submission_method) VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'GOOGLE_SHEET')");
    expect(() => db.public.none("INSERT INTO lenders (id, submission_method) VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'PORTAL')"))
      .toThrow();

    const applied = db.public.many("SELECT id FROM schema_migrations ORDER BY id").map((row: any) => row.id);
    expect(applied).toEqual(["133_recovery_columns_v2.sql"]);
  });
});
