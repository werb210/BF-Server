// BF_SERVER_v890_MAYA_LENDER_UPDATES - Maya proposes lender-profile changes from a meeting; staff approve before anything is written.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { cleanProfileUpdates, decideProfileUpdate, type LenderSnapshot } from "../services/teams/lenderProfileUpdates.js";
import { parseIntel } from "../services/teams/meetingIntel.js";

const LENDER = "11111111-1111-4111-8111-111111111111";
const MEETING = "22222222-2222-4222-8222-222222222222";
const snap: LenderSnapshot = {
  lender: { id: LENDER, name: "Sample Lender Co", silo: "BF", internal_notes: null, primary_contact_name: "Pat Sample" },
  products: [{ id: "p-loc", name: "Sample LOC", category: "LOC", amount_min: 25000, amount_max: 250000, commission: 2 }],
};

describe("cleaning Maya's proposals", () => {
  it("keeps real changes to known fields and drops the rest", () => {
    const out = cleanProfileUpdates([
      { target: "product", product_id: "p-loc", field: "amount_max", proposed: "$500,000", reason: "said they now go to 500k" },
      { target: "product", product_id: "p-loc", field: "amount_min", proposed: 25000, reason: "unchanged" },
      { target: "product", product_id: "nope", field: "amount_max", proposed: 1 },
      { target: "lender", field: "api_key_encrypted", proposed: "x" },
      { target: "lender", field: "internal_notes", proposed: "No longer funds trucking.", reason: "said so" },
      { target: "product", product_id: "p-loc", field: "commission", proposed: 250 },
    ], snap);
    expect(out.map((u) => [u.field, u.proposed])).toEqual([["amount_max", 500000], ["internal_notes", "No longer funds trucking."]]);
    expect(out[0]).toMatchObject({ id: "u1", current: 250000, status: "proposed", product_name: "Sample LOC" });
  });

  it("parses profile_updates only when the meeting is with a lender", () => {
    const raw = JSON.stringify({ summary: "Met the lender.", tasks: [], profile_updates: [{ target: "product", product_id: "p-loc", field: "amount_max", proposed: 300000 }] });
    expect(parseIntel(raw, snap)!.profile_updates).toHaveLength(1);
    expect(parseIntel(raw, null)!.profile_updates).toEqual([]);
  });
});

function fakePool(rules: Parameters<typeof answerBySql>[0]) {
  const query = vi.fn(answerBySql(rules));
  const client = { query, release: vi.fn() };
  return { pool: { connect: async () => client, query } as any, query };
}

const proposal = (over: Record<string, unknown> = {}) => ({
  id: "u1", target: "product", product_id: "p-loc", product_name: "Sample LOC", field: "amount_max", label: "Maximum amount",
  current: 250000, proposed: 500000, reason: "", status: "proposed", ...over,
});

describe("deciding a proposal", () => {
  let meetingRow: any;
  beforeEach(() => { meetingRow = { id: MEETING, silo: "BF", lender_id: LENDER, company_id: null, contact_id: null, updates: [proposal()] }; });

  it("approving writes the value and records the decision", async () => {
    const { pool, query } = fakePool([
      [/FROM teams_meetings tm WHERE tm.id/, () => ({ rows: [meetingRow] })],
      [/SELECT amount_max AS v FROM lender_products/, { rows: [{ v: "250000" }] }],
    ]);
    const u = await decideProfileUpdate(pool, { meetingId: MEETING, updateId: "u1", decision: "approve", userId: null, silo: "BF" });
    expect(u.status).toBe("approved");
    const upd = callsMatching(query, /UPDATE lender_products SET amount_max/);
    expect(upd).toHaveLength(1);
    expect(upd[0][1]).toEqual(["p-loc", 500000, LENDER]);
    expect(callsMatching(query, "COMMIT")).toHaveLength(1);
  });

  it("does not write when the value changed since Maya read it", async () => {
    const { pool, query } = fakePool([
      [/FROM teams_meetings tm WHERE tm.id/, () => ({ rows: [meetingRow] })],
      [/SELECT amount_max AS v FROM lender_products/, { rows: [{ v: "400000" }] }],
    ]);
    const u = await decideProfileUpdate(pool, { meetingId: MEETING, updateId: "u1", decision: "approve", userId: null, silo: "BF" });
    expect(u.status).toBe("stale");
    expect(callsMatching(query, /UPDATE lender_products/)).toHaveLength(0);
  });

  it("adds a dated line to notes instead of replacing them", async () => {
    meetingRow.updates = [proposal({ target: "lender", product_id: null, field: "internal_notes", current: "Old note", proposed: "No trucking." })];
    const { pool, query } = fakePool([
      [/FROM teams_meetings tm WHERE tm.id/, () => ({ rows: [meetingRow] })],
      [/SELECT internal_notes AS v FROM lenders/, { rows: [{ v: "Old note" }] }],
    ]);
    await decideProfileUpdate(pool, { meetingId: MEETING, updateId: "u1", decision: "approve", userId: null, silo: "BF" });
    const value = String(callsMatching(query, /UPDATE lenders SET internal_notes/)[0][1]![1]);
    expect(value).toMatch(/^Old note\n\d{4}-\d{2}-\d{2} \(meeting\): No trucking\.$/);
  });

  it("rejecting writes nothing to the lender, and a second decision is refused", async () => {
    const { pool, query } = fakePool([[/FROM teams_meetings tm WHERE tm.id/, () => ({ rows: [meetingRow] })]]);
    const u = await decideProfileUpdate(pool, { meetingId: MEETING, updateId: "u1", decision: "reject", userId: null, silo: "BF" });
    expect(u.status).toBe("rejected");
    expect(callsMatching(query, /UPDATE lender/)).toHaveLength(0);
    meetingRow.updates = [u];
    await expect(decideProfileUpdate(pool, { meetingId: MEETING, updateId: "u1", decision: "approve", userId: null, silo: "BF" }))
      .rejects.toMatchObject({ code: "already_decided" });
  });

  it("hides a meeting from another silo", async () => {
    const { pool } = fakePool([[/FROM teams_meetings tm WHERE tm.id/, () => ({ rows: [meetingRow] })]]);
    await expect(decideProfileUpdate(pool, { meetingId: MEETING, updateId: "u1", decision: "approve", userId: null, silo: "BI" }))
      .rejects.toMatchObject({ code: "not_found" });
  });
});
