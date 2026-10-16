// BF_SERVER_v818_MERGED_CONTACT - a client-portal chat on an application whose contact was merged away goes to
// the live survivor, so the portal's Messages tab (which hid archived contacts) shows it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  const q = (...a: unknown[]) => h.query(...a);
  return { ...actual, pool: { query: q }, dbQuery: q, runQuery: q };
});

const APP = "app-818";
const LOSER = "22222222-2222-4222-8222-222222222222";
const SURVIVOR = "11111111-1111-4111-8111-111111111111";

beforeEach(() => { h.query.mockReset(); });

describe("v818 ensureApplicationContactForMessage follows a merge", () => {
  it("repoints the application to the live survivor and returns it", async () => {
    h.query.mockImplementation(answerBySql([
      [/SELECT contact_id, silo, metadata/, { rows: [{ contact_id: LOSER, silo: "BF", metadata: {}, business_legal_name: null, name: null }] }],
      [/JOIN contacts surv ON surv.id = c.merged_into_id/, { rows: [{ id: SURVIVOR }] }],
    ]));
    const { ensureApplicationContactForMessage } = await import("../routes/client/index.js");
    await expect(ensureApplicationContactForMessage(APP, "5875550000")).resolves.toBe(SURVIVOR);
    const upd = callsMatching(h.query, /UPDATE applications SET contact_id = \$2::uuid WHERE id::text = \(\$1\)::text$/);
    expect(upd).toHaveLength(1);
    expect(upd[0][1]).toEqual([APP, SURVIVOR]);
  });

  it("keeps a contact that was never merged", async () => {
    h.query.mockImplementation(answerBySql([
      [/SELECT contact_id, silo, metadata/, { rows: [{ contact_id: SURVIVOR, silo: "BF", metadata: {}, business_legal_name: null, name: null }] }],
    ]));
    const { ensureApplicationContactForMessage } = await import("../routes/client/index.js");
    await expect(ensureApplicationContactForMessage(APP, "5875550000")).resolves.toBe(SURVIVOR);
    expect(callsMatching(h.query, /UPDATE applications SET contact_id/)).toHaveLength(0);
  });
});
