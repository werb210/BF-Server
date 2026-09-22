// BF_SERVER_MERGE_PARTIAL_UNIQUE_v409
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildUniqueCollisionSql } from "../routes/crm/contactMerge.js";

describe("v409 a partial unique index no longer breaks a contact merge", () => {
  // The live failure: crm_email_log is
  //   UNIQUE (graph_message_id, contact_id) WHERE graph_message_id IS NOT NULL
  const sql = buildUniqueCollisionSql(
    "crm_email_log",
    ["graph_message_id", "contact_id"],
    "(graph_message_id IS NOT NULL)",
  );

  it("applies the index predicate to both the survivor and the loser side", () => {
    expect(sql.match(/graph_message_id IS NOT NULL/g)?.length).toBe(2);
  });

  it("compares the index's other columns before deleting anything", () => {
    expect(sql).toContain('s."graph_message_id" IS NOT DISTINCT FROM lr."graph_message_id"');
  });

  it("deletes only the loser rows the index actually covers, and returns them for the snapshot", () => {
    expect(sql).toContain('DELETE FROM "crm_email_log" l');
    expect(sql).toContain("l.ctid = lr.bf_merge_ctid");
    expect(sql).toContain("RETURNING l.*");
  });

  it("a full (non-partial) index adds no predicate filter", () => {
    const plain = buildUniqueCollisionSql("ad_attribution", ["contact_id", "gclid"], "true");
    expect(plain).not.toContain(" AND (");
    expect(plain).toContain('s."gclid" IS NOT DISTINCT FROM lr."gclid"');
  });

  it("an index on contact_id alone still matches every loser row", () => {
    const solo = buildUniqueCollisionSql("some_table", ["contact_id"], "true");
    expect(solo).toContain("WHERE true");
    expect(solo).not.toContain("IS NOT DISTINCT FROM");
  });

  it("partial indexes are no longer filtered out of the catalogue query", () => {
    const src = readFileSync(path.join(process.cwd(), "src/routes/crm/contactMerge.ts"), "utf8");
    expect(src).toContain("BF_SERVER_MERGE_PARTIAL_UNIQUE_v409");
    expect(src).not.toContain("AND i.indpred IS NULL");
    expect(src).toContain("pg_get_expr(i.indpred, i.indrelid, true)");
  });
});
