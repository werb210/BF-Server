// BF_SERVER_PRODUCT_SWITCH_RESIGN_v293
import { describe, expect, it, vi } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";

vi.mock("../../push/applicantPush.js", () => ({ notifyApplicant: vi.fn(async () => ({ sent: 1 })) }));
const createNotification = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../../../modules/notifications/notifications.repo.js", () => ({ createNotification }));
const routeQuery = vi.hoisted(() => vi.fn());
vi.mock("../../../db", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db");
  return { ...actual, pool: { query: routeQuery }, runQuery: routeQuery, dbQuery: routeQuery, query: routeQuery };
});

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
});

describe("wiring", () => {
  const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  // The route-level database: the same answers as db() plus the ownership and silo lookups.
  function routeDb(opts: { signedAt?: string | null; history?: any[] } = {}) {
    const inner = db(opts);
    routeQuery.mockReset();
    routeQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/LEFT JOIN application_contacts ac/.test(sql)) return { rows: [{ "?column?": 1 }], rowCount: 1 };
      if (/select id, silo from applications/.test(sql)) return { rows: [{ id: APP_ID, silo: "BF" }] };
      return (inner as any)(sql, params);
    });
  }
  async function mount(path: string, modPath: string) {
    const router = (await import(modPath)).default;
    const { errorHandler } = await import("../../../middleware/errors.js");
    const app = express();
    app.use(express.json());
    app.use(path, router);
    app.use(errorHandler);
    return app;
  }

  it("the client's submission tells staff the answers are in", async () => {
    routeDb();
    createNotification.mockClear();
    const clientToken = jwt.sign({ sub: "client:+15875550142", role: "client", phone: "+15875550142", tokenVersion: 0, isClient: true }, process.env.JWT_SECRET as string);
    const app = await mount("/api/client", "../../../routes/client/productQuestions.js");
    const res = await request(app).post(`/api/client/applications/${APP_ID}/product-questions`).set("Authorization", `Bearer ${clientToken}`).send({ answers: {}, submit: true });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: "PRODUCT_QUESTIONS_ANSWERED", applicationId: APP_ID })));
  });

  it("staff ask for a new signature through POST /:id/product-questions/request-signature", async () => {
    routeDb({ signedAt: signed, history: [{ to: "LINE_OF_CREDIT", at: "2026-09-15T10:00:00Z" }] });
    const staff = jwt.sign({ sub: "00000000-0000-4000-8000-0000000000b1", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
    const app = await mount("/api/applications", "../../../modules/applications/applications.routes.js");
    const res = await request(app).post(`/api/applications/${APP_ID}/product-questions/request-signature`).set("Authorization", `Bearer ${staff}`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(routeQuery.mock.calls.some((c) => String(c[0]).includes("signnow_app_signed_at = NULL"))).toBe(true);

    routeDb({ signedAt: null });
    const refused = await request(app).post(`/api/applications/${APP_ID}/product-questions/request-signature`).set("Authorization", `Bearer ${staff}`).send({});
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: "not_required", message: "This application does not need a new signature." });
  });
});
