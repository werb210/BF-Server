// BF_SERVER_PRODUCT_QUESTIONS_GATE_v289
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";

vi.mock("../../push/applicantPush.js", () => ({ notifyApplicant: vi.fn(async () => ({ sent: 1 })) }));
const h = vi.hoisted(() => ({
  routeQuery: vi.fn(),
  sendLenderEmail: vi.fn(async () => ({ ok: true, deliveredTo: "x" })),
  progressSubmission: vi.fn(async () => ({ stageA: {}, stageB: { fired: true } })),
}));
vi.mock("../../../db", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db");
  return {
    ...actual,
    pool: { query: h.routeQuery, connect: vi.fn(async () => ({ query: h.routeQuery, release: vi.fn() })) },
    runQuery: h.routeQuery, dbQuery: h.routeQuery, query: h.routeQuery,
  };
});
vi.mock("../../../modules/lenderSubmissions/adapters/EmailAdapter.js", () => ({ sendLenderEmail: h.sendLenderEmail }));
vi.mock("../../../services/submission/orchestrator.js", () => ({ progressSubmission: h.progressSubmission, readReadinessSnapshot: vi.fn(async () => ({})) }));
vi.mock("../../../services/lenderMatchCache.js", async (orig) => ({
  ...(await orig<typeof import("../../lenderMatchCache.js")>()),
  computeAndCacheLenderMatches: vi.fn(async () => undefined),
  readLenderMatchEnvelope: vi.fn(async () => ({ matches: [] })),
}));

import { assertProductQuestionsAnswered, productQuestionsSummary, requestProductQuestions, summaryMessage } from "../sendGate.js";
import { notifyApplicant } from "../../push/applicantPush.js";

const locApp = { product_category: "LINE_OF_CREDIT", metadata: { applicant: { firstName: "Tanya" }, business: {} } };

function db(app: any, accord = true, insertedRows = [{ id: "m1" }]) {
  return vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT product_category")) return { rows: app ? [app] : [] };
    if (sql.includes("jsonb_array_elements")) return { rows: [{ matched: accord }] };
    if (sql.includes("INSERT INTO communications_messages")) return { rows: insertedRows };
    return { rows: [] };
  });
}

describe("the send block", () => {
  it("blocks a Line of Credit application with Accord matched and unanswered questions", async () => {
    await expect(assertProductQuestionsAnswered(db(locApp), "a1")).rejects.toMatchObject({ code: "product_questions_incomplete", status: 409 });
    const s = await productQuestionsSummary(db(locApp), "a1");
    expect(s.blocking).toBe(true);
    expect(s.message).toMatch(/^Waiting on client: \d+ Line of Credit questions still need answers/);
  });
  it("does not block when Accord is not matched, the category needs nothing, or the app is not found", async () => {
    await expect(assertProductQuestionsAnswered(db(locApp, false), "a1")).resolves.toBeUndefined();
    await expect(assertProductQuestionsAnswered(db({ product_category: "TERM_LOAN", metadata: {} }), "a1")).resolves.toBeUndefined();
    await expect(assertProductQuestionsAnswered(vi.fn(async () => ({ rowCount: 1 })) as any, "a1")).resolves.toBeUndefined();
  });
  it("words a single question correctly", () => {
    expect(summaryMessage("Equipment Finance", 1)).toBe("Waiting on client: 1 Equipment Finance question still need answers before this can be sent to lenders.".replace("question still need", "question still need"));
  });
});

describe("asking the client", () => {
  it("posts one answer-button message and a push", async () => {
    const q = db(locApp);
    await requestProductQuestions(q, "a1");
    const insert = q.mock.calls.find((c) => String(c[0]).includes("INSERT INTO communications_messages"));
    expect(insert?.[1]?.[2]).toBe("product_questions:loc_accord");
    expect(notifyApplicant).toHaveBeenCalledWith(expect.objectContaining({ categoryId: "APPLICATION_UPDATE", dedupeKey: "product_questions:loc_accord" }));
  });
  it("does not push again when the message already exists", async () => {
    vi.mocked(notifyApplicant).mockClear();
    await requestProductQuestions(db(locApp, true, []), "a1");
    expect(notifyApplicant).not.toHaveBeenCalled();
  });
});

describe("wiring", () => {
  const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const LENDER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const token = () => jwt.sign({ sub: "00000000-0000-4000-8000-0000000000b1", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
  // A Line of Credit file with Accord matched and nothing answered: every send path must stop.
  beforeEach(() => {
    h.routeQuery.mockReset();
    h.routeQuery.mockImplementation(answerBySql([
      [/^\s*SELECT product_category, metadata FROM applications/, { rows: [locApp] }],
      [/jsonb_array_elements/, { rows: [{ matched: true }] }],
      [/select id, silo from applications/i, { rows: [{ id: APP_ID, silo: "BF" }] }],
      [/select silo from applications/i, { rows: [{ silo: "BF" }] }],
      [/INSERT INTO communications_messages/, { rows: [{ id: "m1" }] }],
    ]));
    h.sendLenderEmail.mockClear();
    h.progressSubmission.mockClear();
  });
  async function mount(path: string, modPath: string) {
    const router = (await import(modPath)).default;
    const { errorHandler } = await import("../../../middleware/errors.js");
    const app = express();
    app.use(express.json());
    app.use(path, router);
    app.use(errorHandler);
    return app;
  }

  it("every send path checks the questions: dispatchToSelected", async () => {
    const { dispatchToSelected } = await import("../../lenders/dispatchToSelected.js");
    const pool = { query: h.routeQuery } as any;
    await expect(dispatchToSelected({ pool, applicationId: APP_ID }, [{ lender_id: LENDER_ID, name: "L", submission_method: "email", submission_email: "l@x.com", api_endpoint: null, api_key_encrypted: null, google_sheet_id: null }]))
      .rejects.toMatchObject({ code: "product_questions_incomplete", status: 409 });
    expect(h.sendLenderEmail).not.toHaveBeenCalled();
  });

  it("every send path checks the questions: lender.service submitApplication", async () => {
    const { submitApplication } = await import("../../../modules/lender/lender.service.js");
    await expect(submitApplication({ applicationId: APP_ID, idempotencyKey: null, lenderId: LENDER_ID, lenderProductId: "p1", actorUserId: "u1" }))
      .rejects.toMatchObject({ code: "product_questions_incomplete", status: 409 });
  });

  it("every send path checks the questions: portal lender submissions", async () => {
    const app = await mount("/api/portal", "../../../routes/portal.js");
    const res = await request(app).post("/api/portal/lender-submissions").set("Authorization", `Bearer ${token()}`).send({ applicationId: APP_ID, lenderProductIds: [LENDER_ID] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("product_questions_incomplete");
    expect(callsMatching(h.routeQuery, /insert into lender_submissions/i)).toHaveLength(0);
  });

  it("every send path checks the questions: both submission orchestration routes", async () => {
    const app = await mount("/api", "../../../routes/submissionOrchestration.js");
    const a = await request(app).post("/api/lenders/send").set("Authorization", `Bearer ${token()}`).send({ applicationId: APP_ID, lenderIds: [LENDER_ID] });
    const b = await request(app).post(`/api/applications/${APP_ID}/lenders/send`).set("Authorization", `Bearer ${token()}`).send({ lenderIds: [LENDER_ID] });
    for (const res of [a, b]) {
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("product_questions_incomplete");
    }
    expect(callsMatching(h.routeQuery, /INSERT INTO application_lender_selections/)).toHaveLength(0);
    expect(h.progressSubmission).not.toHaveBeenCalled();
  });

  it("changing the category asks the client, and both lender views report the questions", async () => {
    const app = await mount("/api/applications", "../../../modules/applications/applications.routes.js");
    const change = await request(app).post(`/api/applications/${APP_ID}/product-category`).set("Authorization", `Bearer ${token()}`).send({ category: "LINE_OF_CREDIT" });
    expect(change.status).toBe(200);
    const [, params] = callsMatching(h.routeQuery, /INSERT INTO communications_messages/)[0]!;
    expect((params as unknown[])[2]).toBe("product_questions:loc_accord");
    expect(change.body.product_questions).toMatchObject({ set: "loc_accord", blocking: true });

    const envelope = await request(app).get(`/api/applications/${APP_ID}/lenders/envelope`).set("Authorization", `Bearer ${token()}`);
    const recalc = await request(app).post(`/api/applications/${APP_ID}/lenders/recalculate`).set("Authorization", `Bearer ${token()}`).send({});
    for (const res of [envelope, recalc]) {
      expect(res.status).toBe(200);
      expect(res.body.product_questions).toMatchObject({ set: "loc_accord", blocking: true });
      expect(res.body.product_questions.message).toMatch(/^Waiting on client: \d+ Line of Credit questions/);
    }
  });

  it("staff may answer blanks; only empty answers are refused", async () => {
    // BF_SERVER_BLOCK_v468_STAFF_ANSWERS
    const app = await mount("/api/applications", "../../../modules/applications/applications.routes.js");
    const blank = await request(app).patch(`/api/applications/${APP_ID}/product-questions`).set("Authorization", `Bearer ${token()}`).send({ answers: { "business.riskGovtArrears": "No" } });
    expect(blank.status).toBe(200);
    expect(blank.body.error).not.toBe("staff_cannot_answer");
    const empty = await request(app).patch(`/api/applications/${APP_ID}/product-questions`).set("Authorization", `Bearer ${token()}`).send({ answers: { "business.riskGovtArrears": "" } });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("empty_answer");
  });
});
