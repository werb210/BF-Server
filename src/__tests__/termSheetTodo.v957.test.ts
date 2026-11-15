// BF_SERVER_v957_OFFER_IN_APP - a term sheet waiting for the client's signature is on the client's to-do list.
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../routes/clientDocumentsNeeded.js", async (orig) => ({
  ...(await orig<any>()),
  computeOutstandingDocs: async () => ({ required: [], stillNeeded: [], rejected: [] }),
  getRequestedFormIds: async () => [],
  getWaivedDocTypes: async () => new Set<string>(),
}));
vi.mock("../signnow/sba/sbaTrigger.js", async (orig) => ({ ...(await orig<any>()), isSbaApplication: async () => false }));

import { buildActionCenter, TERM_SHEET_TODO_LABEL } from "../services/applicantActions.js";

const base: Array<[RegExp, unknown]> = [
  [/SELECT cta_label, cta_action FROM communications_messages/, { rows: [] }],
  [/SELECT doc_type FROM application_form_responses/, { rows: [] }],
  [/FROM media_fee_agreements/, { rows: [] }],
];
const signingQuery = /metadata->'offer_signnow'->>'signing_url'/;

beforeEach(() => { h.query.mockReset(); });

describe("term sheet out for signature", () => {
  it("is something to do until it is signed", async () => {
    h.query.mockImplementation(answerBySql([...base, [signingQuery, { rows: [{ signed: false }] }]] as any));
    const c = await buildActionCenter(APP);
    const item = c.outstanding.find((i) => i.key === "term_sheet_sign");
    expect(item).toMatchObject({ kind: "action", label: TERM_SHEET_TODO_LABEL, action: "offers", urgent: true });
    expect(c.outstandingCount).toBe(1);
  });
  it("moves to done once signed", async () => {
    h.query.mockImplementation(answerBySql([...base, [signingQuery, { rows: [{ signed: true }] }]] as any));
    const c = await buildActionCenter(APP);
    expect(c.outstanding.find((i) => i.key === "term_sheet_sign")).toBeUndefined();
    expect(c.completed.find((i) => i.key === "term_sheet_sign")).toBeTruthy();
  });
  it("is not listed when nothing was sent for signature", async () => {
    h.query.mockImplementation(answerBySql([...base, [signingQuery, { rows: [] }]] as any));
    const c = await buildActionCenter(APP);
    expect(c.outstanding).toEqual([]);
  });
});
