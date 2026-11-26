// BF_SERVER_NO_IMPORTS_IN_BF_v1 - imported lists come back out of the BF CRM; records kept elsewhere lose the list tags.
import { describe, expect, it, vi } from "vitest";
import { cleanBfImports } from "../directory/bfImportCleanup.js";

// The database answers by SQL content, not call order.
function fakeDb(tags: string[]) {
  const calls: Array<{ sql: string; p: unknown[] }> = [];
  return {
    calls,
    query: vi.fn(async (sql: string, p: unknown[] = []) => {
      calls.push({ sql, p });
      if (/WITH listed AS/.test(sql)) return { rows: tags.map((t) => ({ t })) };
      if (/^\s*SELECT count\(\*\)::int AS n FROM \(SELECT c\.id FROM contacts c WHERE c\.silo = 'BF' AND c\.tags && \$1/.test(sql)) return { rows: [{ n: 7 }] };
      if (/^\s*SELECT count\(\*\)::int AS n FROM \(SELECT c\.id FROM contacts c WHERE c\.silo = 'BF' AND c\.tags && \$2/.test(sql)) return { rows: [{ n: 2 }] };
      if (/FROM companies co WHERE co\.silo = 'BF' AND co\.tags && \$1::text\[\] AND co\.tags <@/.test(sql)) return { rows: [{ n: 3 }] };
      if (/co\.tags && \$1::text\[\]$/.test(sql.trim())) return { rows: [{ n: 5 }] };
      if (/FROM directory_brand_status/.test(sql) && /count/.test(sql)) return { rows: [{ n: 4 }] };
      if (/DELETE FROM contacts/.test(sql)) return { rows: [{ id: "c1" }], rowCount: 1 };
      if (/DELETE FROM companies/.test(sql)) return { rows: [{ id: "co1" }], rowCount: 1 };
      if (/^\s*UPDATE contacts/.test(sql)) return { rows: [], rowCount: 2 };
      if (/^\s*UPDATE companies/.test(sql)) return { rows: [], rowCount: 4 };
      if (/DELETE FROM directory_brand_status/.test(sql)) return { rows: [], rowCount: 6 };
      return { rows: [] };
    }),
  };
}

const TAGS = ["bank", "lender", "lender contact", "list 8 2026-11-26"];

describe("cleanBfImports", () => {
  it("only counts in preview, and writes nothing", async () => {
    const db = fakeDb(TAGS);
    const out = await cleanBfImports(db as any, { preview: true });
    expect(out).toMatchObject({ preview: true, contacts_removed: 7, contacts_untagged: 2, companies_removed: 3, companies_untagged: 2, directory_marks_removed: 4 });
    expect(db.calls.some((c) => /\b(DELETE|UPDATE|INSERT)\b/.test(c.sql))).toBe(false);
  });
  it("backs up each record before removing it, and strips list tags but keeps lender and broker", async () => {
    const db = fakeDb(TAGS);
    const out = await cleanBfImports(db as any, { preview: false });
    expect(out).toMatchObject({ contacts_removed: 1, companies_removed: 1, contacts_untagged: 2, companies_untagged: 4, directory_marks_removed: 6 });
    const deletes = db.calls.filter((c) => /DELETE FROM (contacts|companies)/.test(c.sql));
    expect(deletes).toHaveLength(2);
    for (const d of deletes) expect(d.sql).toMatch(/INSERT INTO bf_import_cleanup_backup/);
    const strip = db.calls.find((c) => /^\s*UPDATE contacts/.test(c.sql))!;
    expect(strip.p[0]).toEqual(["bank", "lender contact", "list 8 2026-11-26"]);
    expect(db.calls.some((c) => /INSERT INTO bf_import_cleanup_runs/.test(c.sql))).toBe(true);
  });
  it("does nothing when BF holds no import tags", async () => {
    const db = fakeDb([]);
    const out = await cleanBfImports(db as any, { preview: false });
    expect(out.contacts_removed).toBe(0);
    expect(db.calls).toHaveLength(1);
  });
});
