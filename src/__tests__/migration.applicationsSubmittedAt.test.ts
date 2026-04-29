// BF_APPLICATIONS_SUBMITTED_AT_v62 — migration file presence + content lint.
//
// This is a static check that the migration file:
//   1. Exists on disk at migrations/20260429_applications_submitted_at.sql
//   2. Adds the `submitted_at` column to the `applications` table
//      (the missing column that caused every wizard submit to 500 with
//       'column "submitted_at" of relation "applications" does not exist')
//   3. Uses IF NOT EXISTS for idempotency (per project rule)
//   4. Has a partial index on submitted_at
//
// We don't actually run the SQL here — the runMigrations test harness uses
// mocks. Real DB validation was done locally with Postgres 16 against a
// realistic applications fixture; backfill from metadata.submittedAt and
// metadata.formData.submittedAt verified, idempotent re-run verified.
//
// This test exists to catch a regression where the file is moved, renamed,
// or someone strips IF NOT EXISTS thinking it's redundant.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const MIGRATION_PATH = join(process.cwd(), "migrations", "20260429_applications_submitted_at.sql");

describe("BF_APPLICATIONS_SUBMITTED_AT_v62 — migration file", () => {
  it("exists in migrations/", () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
  });

  it("adds submitted_at column to applications with IF NOT EXISTS", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    // Project rule: all migrations IF NOT EXISTS, fully idempotent.
    expect(sql).toMatch(
      /ALTER\s+TABLE\s+applications\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+submitted_at\s+TIMESTAMPTZ/i
    );
  });

  it("creates a partial index on submitted_at IF NOT EXISTS", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    expect(sql).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+applications_submitted_at_idx/i
    );
    expect(sql).toMatch(/WHERE\s+submitted_at\s+IS\s+NOT\s+NULL/i);
  });

  it("backfills submitted_at from existing metadata when available", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    // Either pattern is fine; the migration walks both top-level and formData.
    expect(sql).toContain("metadata->>'submittedAt'");
    expect(sql).toContain("metadata->'formData'->>'submittedAt'");
  });

  it("carries the v62 anchor", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    expect(sql).toContain("BF_APPLICATIONS_SUBMITTED_AT_v62");
  });
});

// BF_APPLICATIONS_SUBMITTED_AT_v62_TEST_ANCHOR
