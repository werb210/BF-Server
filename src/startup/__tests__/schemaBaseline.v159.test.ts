// BF_SERVER_SCHEMA_BASELINE_v159
// Verified against a real Postgres 16: the runner dies on
// 018_ocr_results_fields.sql, and roughly 22 migrations fail in total on an
// empty database. Production boots only because all of them are already
// recorded in schema_migrations.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const runner = readFileSync(resolve(__dirname, "..", "runMigrations.ts"), "utf-8");
const MIGRATIONS = resolve(process.cwd(), "migrations");

describe("the ordering problem this exists for", () => {
  it("018 sorts before the 018b that creates the table it uses", () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.startsWith("018")).sort();
    expect(files.indexOf("018_ocr_results_fields.sql"))
      .toBeLessThan(files.indexOf("018b_document_ocr_fields_bootstrap.sql"));
    const early = readFileSync(resolve(MIGRATIONS, "018_ocr_results_fields.sql"), "utf-8");
    expect(early).toContain("document_ocr_fields");
    const later = readFileSync(resolve(MIGRATIONS, "018b_document_ocr_fields_bootstrap.sql"), "utf-8");
    expect(later).toContain("create table if not exists document_ocr_fields");
  });
});

describe("the baseline only touches an empty database", () => {
  it("requires no recorded history", () => {
    expect(runner).toContain("applied.size === 0");
  });

  it("and requires no existing tables", () => {
    expect(runner).toContain("to_regclass('public.applications') IS NOT NULL");
  });

  it("refuses a half-built database rather than overwriting it", () => {
    expect(runner).toContain("tables exist but schema_migrations is empty - NOT applying the baseline");
  });

  it("is excluded from the ordinary migration loop", () => {
    expect(runner).toContain('const ordinaryFiles = files.filter((f) => f !== BASELINE_FILE)');
    expect(runner).toContain("for (const file of ordinaryFiles) {");
  });
});

describe("it records history so the broken migrations never run", () => {
  it("marks every historical file applied", () => {
    expect(runner).toContain("for (const f of ordinaryFiles) {");
    expect(runner).toContain("INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING");
  });

  it("records the baseline itself too", () => {
    expect(runner).toContain("[BASELINE_FILE],");
  });

  it("makes room for the dump's own schema_migrations", () => {
    // ensureTrackingTable creates it before the baseline runs, and the dump
    // contains it too - so the baseline would fail on "already exists".
    expect(runner).toContain('DROP TABLE IF EXISTS schema_migrations');
    const i = runner.indexOf("DROP TABLE IF EXISTS schema_migrations");
    expect(runner.slice(i, i + 300)).toContain("await client.query(baselineSql)");
  });

  it("restores search_path, which the dump blanks", () => {
    expect(runner).toContain('SET search_path TO public');
    const i = runner.indexOf("await client.query(baselineSql)");
    expect(runner.slice(i, i + 500)).toContain("SET search_path TO public");
  });

  it("does it in one transaction", () => {
    const i = runner.indexOf("applying schema baseline");
    const block = runner.slice(i, i + 3000);
    expect(block).toContain('await client.query("BEGIN")');
    expect(block).toContain('await client.query("COMMIT")');
  });
});

describe("pg_dump 17 output is executable by the node client", () => {
  it("strips the psql-only restrict markers", () => {
    // pg_dump 17.6+ brackets output with \\restrict / \\unrestrict, which are
    // psql meta-commands the pg client cannot parse.
    expect(runner).toContain('rest.startsWith("restrict")');
    expect(runner).toContain("String.fromCharCode(10)");
  });
});
