// BF_SERVER_STARTUP_WAITLIST_v1
import request from "supertest";
import jwt from "jsonwebtoken";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";
import { mountRouter } from "../../../__tests__/helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({ query: vi.fn(), sendSms: vi.fn(), notifyOnce: vi.fn() }));
vi.mock("../../../db.js", async () => ({
  ...(await vi.importActual<any>("../../../db.js")),
  pool: { query: h.query, connect: async () => ({ query: h.query, release: () => undefined }) },
  runQuery: h.query,
  dbQuery: h.query,
}));
vi.mock("../../notifications/sms.service.js", async () => ({
  ...(await vi.importActual<any>("../../notifications/sms.service.js")),
  sendSms: h.sendSms,
}));
// The real one-time blast, observed.
vi.mock("../startupWaitlist.service.js", async () => {
  const actual = await vi.importActual<any>("../startupWaitlist.service.js");
  h.notifyOnce.mockImplementation(() => actual.notifyStartupWaitlistOnce());
  return { ...actual, notifyStartupWaitlistOnce: h.notifyOnce };
});

import { submitReferral } from "../referrals.service.js";
import { notifyStartupWaitlistOnce } from "../startupWaitlist.service.js";

const REFERRER = "5e5e5e5e-0000-4000-8000-000000000001";
const LENDER_PRODUCT_COLUMNS = [
  "id", "lender_id", "name", "active", "status", "country", "rate_type", "interest_min", "interest_max",
  "term_min", "term_max", "amount_min", "amount_max", "silo", "term_unit", "commission", "min_credit_score",
  "category", "type", "required_documents", "signnow_template_id", "eligibility_notes", "rate_kind",
  "rate_min_num", "rate_max_num", "category_label", "documents_required", "created_at", "updated_at",
];
const startupTagged = () => callsMatching(h.query, /ARRAY\['startup_capital'\]::text\[\]/);
const referral = (extra: Record<string, unknown> = {}) => ({
  businessName: "Seed Co", contactName: "Sam Seed", website: null, email: null, phone: "+14035550199", referrerId: null, silos: [] as string[], ...extra,
});

const REFERRAL_WRITES: Array<[RegExp, unknown]> = [
  [/insert into companies/, (_s: string, p?: unknown[]) => ({ rows: [{ id: p?.[0] }] })],
  [/insert into contacts/i, (_s: string, p?: unknown[]) => ({ rows: [{ id: p?.[0] }] })],
];

beforeEach(() => {
  h.query.mockReset().mockImplementation(answerBySql(REFERRAL_WRITES));
  h.sendSms.mockReset().mockResolvedValue(undefined);
  h.notifyOnce.mockClear();
});

describe("startup waitlist", () => {
  it("startup referral is waitlisted: tagged, no intro sent", async () => {
    await submitReferral(referral({ startup: true }) as any);
    expect(startupTagged()).toHaveLength(1);
    const [silos] = callsMatching(h.query, /SET ref_code = \$2/);
    expect((silos[1] as unknown[])[2]).toEqual([]);
    expect(h.sendSms).not.toHaveBeenCalled();
  });

  it("an ordinary referral still gets its BF intro and no waitlist tag", async () => {
    await submitReferral(referral() as any);
    expect(startupTagged()).toHaveLength(0);
    expect(h.sendSms).toHaveBeenCalledTimes(1);
  });

  it("add-referral parses the startup flag", async () => {
    const token = jwt.sign({ sub: `referrer:${REFERRER}`, role: "Referrer", referrerId: REFERRER }, String(process.env.JWT_SECRET), { algorithm: "HS256" });
    const app = mountRouter((await import("../../../routes/referrerSelf.js")).default, "/api/referrer");
    const res = await request(app).post("/api/referrer/add-referral").set("Authorization", `Bearer ${token}`)
      .send({ full_name: "Sam Seed", phone: "+14035550199", referrer_name: "Rae", startup: true });
    expect(res.status).toBe(201);
    expect(res.body.data.silos).toEqual([]);
    expect(startupTagged()).toHaveLength(1);
    expect(h.sendSms).not.toHaveBeenCalled();
  });

  it("startup capital product create triggers the one-time blast; other products do not", async () => {
    h.query.mockImplementation(answerBySql([
      [/information_schema\.columns/, { rows: LENDER_PRODUCT_COLUMNS.map((column_name) => ({ column_name })) }],
      [/insert into lender_products/, { rows: [{ id: "lp-1" }] }],
    ]));
    const { createLenderProduct } = await import("../../../repositories/lenderProducts.repo.js");
    await createLenderProduct({ lenderId: "l-1", name: "Term", active: true, category: "TERM", requiredDocuments: [] as any });
    await new Promise((r) => setImmediate(r));
    expect(h.notifyOnce).not.toHaveBeenCalled();
    await createLenderProduct({ lenderId: "l-1", name: "Launch", active: true, category: "Startup Capital", requiredDocuments: [] as any });
    await vi.waitFor(() => expect(h.notifyOnce).toHaveBeenCalledTimes(1));
  });

  it("service sends once to the waitlist + marks notified", async () => {
    h.query.mockImplementation(answerBySql([
      [/'startup_capital' = ANY/, { rows: [{ id: "c-1", phone: "+14035550199", name: "Sam Seed", ref_code: "ABC" }] }],
    ]));
    expect(await notifyStartupWaitlistOnce()).toEqual({ notified: 1 });
    const [pick] = callsMatching(h.query, /'startup_capital' = ANY/);
    expect(String(pick[0])).toContain("NOT ('startup_notified' = ANY");
    expect(h.sendSms).toHaveBeenCalledWith(expect.objectContaining({ to: "+14035550199" }));
    expect(String(h.sendSms.mock.calls[0][0].message)).toContain("Sam, good news");
    const [mark] = callsMatching(h.query, /ARRAY\['startup_notified'\]::text\[\]/);
    expect(mark[1]).toEqual(["c-1"]);
  });
});
