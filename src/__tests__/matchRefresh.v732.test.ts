// BF_SERVER_MATCH_REFRESH_v732
import { readFileSync } from "node:fs";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), matchLenders: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, runQuery: h.query, dbQuery: h.query }));
vi.mock("../ai/lenderMatchEngine.js", async () => ({
  ...(await vi.importActual<any>("../ai/lenderMatchEngine.js")),
  matchLenders: h.matchLenders,
}));

// Every column createLenderProduct asks information_schema about.
const LENDER_PRODUCT_COLUMNS = [
  "id", "lender_id", "name", "active", "status", "country", "rate_type", "interest_min", "interest_max",
  "term_min", "term_max", "amount_min", "amount_max", "silo", "term_unit", "commission", "min_credit_score",
  "category", "type", "required_documents", "signnow_template_id", "eligibility_notes", "rate_kind",
  "rate_min_num", "rate_max_num", "category_label", "documents_required", "created_at", "updated_at",
];

beforeEach(() => {
  h.query.mockReset().mockImplementation(answerBySql([]));
  h.matchLenders.mockReset();
});

describe("lender lists refresh when lenders change", () => {
  it("open files computed before now are refreshed once", () => {
    expect(readFileSync("migrations/2026_10_03_v732_refresh_open_matches.sql", "utf8")).toContain("UPDATE applications SET lender_matches_stale = true");
  });

  it("files out to lenders are marked out of date too", async () => {
    h.query.mockImplementation(answerBySql([
      [/information_schema\.columns/, { rows: LENDER_PRODUCT_COLUMNS.map((column_name) => ({ column_name })) }],
      [/insert into lender_products/, { rows: [{ id: "lp-1", name: "Bondit Term", category: "TERM" }] }],
    ]));
    const { createLenderProduct } = await import("../repositories/lenderProducts.repo.js");
    await createLenderProduct({ lenderId: "l-1", name: "Bondit Term", active: true, category: "TERM", requiredDocuments: [] as any });
    await vi.waitFor(() => expect(callsMatching(h.query, /lender_matches_stale = true/)).toHaveLength(1));
    const sql = String(callsMatching(h.query, /lender_matches_stale = true/)[0][0]);
    expect(sql).toContain("'Additional Steps Required','Off to Lender','Offer')");
  });

  it("out-of-date lists are recalculated when the Lenders tab opens", async () => {
    const fresh = [{ lenderId: "l-new", productId: "lp-1", score: 90 }];
    h.matchLenders.mockResolvedValue(fresh);
    h.query.mockImplementation(answerBySql([
      [/SELECT lender_matches, lender_matches_computed_at, lender_matches_stale/, {
        rows: [{ lender_matches: [{ lenderId: "l-old" }], lender_matches_computed_at: "2026-10-01T00:00:00Z", lender_matches_stale: true, lender_matches_inputs: null, lender_matches_missing_inputs: [] }],
      }],
      [/SELECT id, metadata, requested_amount, product_category FROM applications/, {
        rows: [{ id: "app-1", metadata: {}, requested_amount: 50000, product_category: "TERM" }],
      }],
    ]));
    const { readLenderMatchEnvelope } = await import("../services/lenderMatchCache.js");
    const envelope = await readLenderMatchEnvelope("app-1");
    expect(h.matchLenders).toHaveBeenCalledTimes(1);
    expect(envelope.status).toBe("ready");
    expect(envelope.matches.map((m: any) => m.lenderId)).toEqual(["l-new"]);
    expect(envelope.computed_at).not.toBe("2026-10-01T00:00:00Z");
    // The fresh list is written back and the stale flag cleared.
    expect(String(callsMatching(h.query, /SET lender_matches = \$1::jsonb/)[0][0])).toContain("lender_matches_stale = false");
  });
});
