// BF_SERVER_PRODUCT_SWITCH_RESIGN_v293
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";

vi.mock("../../push/applicantPush.js", () => ({ notifyApplicant: vi.fn(async () => ({ sent: 1 })) }));
const createNotification = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../../../modules/notifications/notifications.repo.js", () => ({ createNotification }));

import { notifyStaffQuestionsAnswered, productQuestionsSummary, requestResignature, resignNeeded } from "../sendGate.js";

const signed = "2026-09-10T12:00:00Z";
const answeredMd = {
  applicant: { firstName: "Tanya", ownRent: "Rent", addressSince: "2019-04", director: "Yes", officer: "Yes", bankruptcyFiled: "No" },
  business: { fiscalYearEnd: "December", inBusinessSince: "2015-06", mailingSameAsOperating: true, riskMultipleLocations: "No", riskBusinessBankruptcy: "No", riskOwnerBankruptcyPersonal: "No", riskOwnerBankruptcyOtherBiz: "No", riskGovtArrears: "No" },
};

function db(opts: { signedAt?: string | null; history?: any[]; progress?: any } = {}) {
  return vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT product_category")) return { rows: [{ product_category: "LINE_OF_CREDIT", metadata: answeredMd }] };
    if (sql.includes("jsonb_array_elements")) return { rows: [{ matched: true }] };
    if (sql.includes("signnow_app_signed_at AS signed_at")) return { rows: [{ signed_at: opts.signedAt ?? null, history: opts.history ?? [], progress: opts.progress ?? {} }] };
    if (sql.startsWith("SELECT name")) return { rows: [{ name: "Voss Events Inc" }] };
    return { rows: [] };
  });
}

describe("when a new signature is needed", () => {
  it("only for Line of Credit changes made after the client signed", () => {
    expect(resignNeeded({ set: "loc_accord", signedAt: signed, history: [{ to: "LINE_OF_CREDIT", at: "2026-09-15T10:00:00Z" }], progress: {} })).toBe(true);
    expect(resignNeeded({ set: "loc_accord", signedAt: signed, history: [{ to: "LINE_OF_CREDIT", at: "2026-09-01T10:00:00Z" }], progress: {} })).toBe(false);
    expect(resignNeeded({ set: "loc_accord", signedAt: signed, history: [], progress: { loc_accord: { staff_edits: [{ at: "2026-09-16T09:00:00Z" }] } } })).toBe(true);
    expect(resignNeeded({ set: "loc_accord", signedAt: null, history: [{ to: "LINE_OF_CREDIT", at: "2026-09-15T10:00:00Z" }], progress: {} })).toBe(false);
    expect(resignNeeded({ set: "equipment", signedAt: signed, history: [{ to: "EQUIPMENT_FINANCE", at: "2026-09-15T10:00:00Z" }], progress: {} })).toBe(false);
  });
  it("blocks sending with a clear reason once the answers are in", async () => {
    const s = await productQuestionsSummary(db({ signedAt: signed, history: [{ to: "LINE_OF_CREDIT", at: "2026-09-15T10:00:00Z" }] }) as any, "a1");
    expect(s).toMatchObject({ missingCount: 0, resignRequired: true, blocking: true });
    expect(s.message).toContain("Waiting on client signature");
  });
});

describe("asking the client to sign again", () => {
  it("archives the old signature, clears it, and messages the client", async () => {
    const q = db({ signedAt: signed, history: [{ to: "LINE_OF_CREDIT", at: "2026-09-15T10:00:00Z" }] });
    expect(await requestResignature(q as any, "a1", "u-1")).toEqual({ ok: true });
    const upd = q.mock.calls.find((c) => String(c[0]).includes("signing_history"));
    expect(String(upd?.[0])).toContain("signnow_app_signed_at = NULL");
    const msg = q.mock.calls.find((c) => String(c[0]).includes("INSERT INTO communications_messages"));
    expect(String(msg?.[0])).toContain("'sign'");
  });
  it("refuses when no new signature is needed", async () => {
    expect(await requestResignature(db({ signedAt: null }) as any, "a1", "u-1")).toEqual({ ok: false, reason: "not_required" });
  });
});

describe("staff notification", () => {
  it("tells staff the answers are in", async () => {
    await notifyStaffQuestionsAnswered(db() as any, "a1");
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: "PRODUCT_QUESTIONS_ANSWERED", title: "Client answered the Line of Credit questions" }));
  });
  it("is wired to the client submission and the staff route", () => {
    expect(fs.readFileSync("src/routes/client/productQuestions.ts", "utf8")).toContain("notifyStaffQuestionsAnswered(query, id)");
    expect(fs.readFileSync("src/modules/applications/applications.routes.ts", "utf8")).toContain("router.post('/:id/product-questions/request-signature'");
  });
});
