// BF_SERVER_CONTACT_MERGE_COLS_FIX_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const src = readFileSync(path.join(process.cwd(), "src/routes/crm/contactMerge.ts"), "utf8");

describe("uniqueColumnSets returns a real array", () => {
  it("casts attname to text so node-pg parses it as an array, not a string", () => {
    // array_agg(a.attname) is name[] (OID 1003); node-pg has no parser for it and hands
    // back "{contact_id,sequence_id}" as a string. .filter() then throws and the merge 500s.
    expect(src).toContain("a.attname::text");
    expect(src).not.toMatch(/array_agg\(a\.attname ORDER BY/);
    expect(src).not.toMatch(/ANY\(array_agg\(a\.attname\)\)/);
  });

  it("defensively parses a Postgres array literal if the driver ever hands back a string", () => {
    expect(src).toContain("toColumnArray");
  });
});
