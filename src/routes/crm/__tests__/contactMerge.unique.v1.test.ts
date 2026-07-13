// BF_SERVER_CONTACT_MERGE_UNIQUE_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const src = readFileSync(path.join(process.cwd(), "src/routes/crm/contactMerge.ts"), "utf8");
const seq = readFileSync(path.join(process.cwd(), "migrations/2026_06_30_sequences.sql"), "utf8");

describe("contact merge survives unique constraints on contact_id", () => {
  it("the constraint that broke the live merge still exists, so this fix stays necessary", () => {
    // Merging the two Amir Ghanem records 500'd with
    // "duplicate key value violates unique constraint marketing_sequence_enrollments_..."
    // because both contacts were enrolled in the SAME sequence.
    expect(seq).toContain("UNIQUE (sequence_id, contact_id)");
  });

  it("discovers unique column sets at runtime instead of hardcoding a table list", () => {
    expect(src).toContain("uniqueColumnSets");
    expect(src).toContain("pg_index");
    expect(src).toContain("i.indisunique");
  });

  it("deletes colliding loser rows BEFORE repointing, not after", () => {
    const del = src.indexOf("DELETE FROM ${quoteIdent(t)} l");
    const upd = src.indexOf("UPDATE ${quoteIdent(t)} SET contact_id");
    expect(del).toBeGreaterThan(-1);
    expect(upd).toBeGreaterThan(-1);
    expect(del).toBeLessThan(upd);
  });

  it("keeps the merge reversible by snapshotting every dropped row", () => {
    expect(src).toContain("RETURNING *");
    expect(src).toContain("{ contact: loser, dropped }");
  });

  it("reports deduped rows separately so a merge never silently loses data", () => {
    expect(src).toContain(":deduped");
  });
});
