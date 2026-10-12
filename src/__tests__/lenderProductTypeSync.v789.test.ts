// BF_SERVER_v789_LP_TYPE_SYNC - changing a product's category also rewrites type.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

vi.mock("../db.js", () => ({
  pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  runQuery: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}));

import { updateLenderProduct } from "../repositories/lenderProducts.repo.js";

const COLUMNS = [
  "id", "lender_id", "name", "active", "category", "type", "country", "rate_type", "interest_min",
  "interest_max", "term_min", "term_max", "amount_min", "amount_max", "silo", "term_unit",
  "required_documents", "rate_kind", "rate_min_num", "rate_max_num", "category_label",
  "documents_required", "created_at", "updated_at",
];

function makeClient() {
  const query = vi.fn(answerBySql([
    [/information_schema\.columns/, { rows: COLUMNS.map((column_name) => ({ column_name })) }],
    [/update lender_products/i, { rows: [{ id: "p1" }], rowCount: 1 }],
  ]));
  return { query } as any;
}

function updateCall(client: { query: ReturnType<typeof vi.fn> }) {
  const calls = callsMatching(client.query, /update lender_products/i);
  expect(calls).toHaveLength(1);
  return { sql: String(calls[0]![0]), values: calls[0]![1] as unknown[] };
}

describe("updateLenderProduct keeps type in step with category", () => {
  it("sets type = category in the same UPDATE when category changes", async () => {
    const client = makeClient();
    await updateLenderProduct({ id: "p1", name: "Term A", requiredDocuments: [] as any, category: "TERM", client });
    const { sql, values } = updateCall(client);
    const set = sql.slice(sql.indexOf("set"), sql.indexOf("where"));
    const catIdx = /category = \$(\d+)/.exec(set);
    const typeIdx = /\btype = \$(\d+)/.exec(set);
    expect(catIdx).not.toBeNull();
    expect(typeIdx).not.toBeNull();
    expect(values[Number(typeIdx![1]) - 1]).toBe("TERM");
    expect(values[Number(catIdx![1]) - 1]).toBe("TERM");
  });

  it("leaves type alone when category is not part of the update", async () => {
    const client = makeClient();
    await updateLenderProduct({ id: "p1", name: "Term A", requiredDocuments: [] as any, client });
    const { sql } = updateCall(client);
    expect(/\btype = \$/.test(sql.slice(sql.indexOf("set"), sql.indexOf("where")))).toBe(false);
  });
});

describe("v789 migration backfills type from category", () => {
  it("has an idempotent backfill in section [G]", () => {
    const sql = readFileSync(resolve(__dirname, "..", "..", "migrations", "2026_10_12_v789_audit2.sql"), "utf-8");
    const g = sql.slice(sql.indexOf("-- ===== [G] misc ====="), sql.indexOf("-- ===== end ====="));
    expect(g).toMatch(/UPDATE lender_products\s+SET type = category/i);
    expect(g).toMatch(/IS DISTINCT FROM/i);
  });
});
