// BF_SERVER_BANK_CRA_ON_REQUEST_v691
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const { queryMock, notifyClient } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  notifyClient: vi.fn(async () => ({ channel: "sms" })),
}));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return {
    ...actual,
    pool: { query: queryMock, connect: vi.fn(async () => ({ query: queryMock, release: vi.fn() })) },
    runQuery: queryMock, dbQuery: queryMock, query: queryMock, safeQuery: queryMock,
  };
});
vi.mock("../services/notifications/notifyClient.js", () => ({ notifyClient }));

const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STAFF_ID = "00000000-0000-4000-8000-0000000000b1";
const AUTO = "NOT (staff_name IS NULL AND cta_action IN ('cra','flinks','form:cra','form:flinks'))";
const staffToken = () => jwt.sign({ sub: STAFF_ID, role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

beforeEach(() => {
  queryMock.mockReset();
  notifyClient.mockClear();
});

describe("Connect Bank and CRA Authorization only when staff request them", () => {
  it("submit no longer requests them automatically", async () => {
    queryMock.mockImplementation(answerBySql([
      [/SELECT id, silo, owner_user_id\s+FROM applications/, { rows: [{ id: APP_ID, silo: "BF", owner_user_id: null }] }],
      [/LEFT JOIN contacts c ON c\.id = a\.contact_id/, { rows: [{ phone: "+15875550142" }] }],
    ]));
    const router = (await import("../routes/client/v1Applications.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/client", router);
    const res = await request(app).post(`/api/client/applications/${APP_ID}/submit`).send({
      app: {
        productRequirements: {
          aggregated: [
            { document_type: "Connect bank (Flinks)", required: true, stage: 2 },
            { document_type: "CRA Authorization", required: true, stage: 2 },
            { document_type: "Personal Net Worth", required: true, stage: 2 },
          ],
        },
      },
    });
    expect(res.status).toBe(200);
    const ctas = callsMatching(queryMock, /INSERT INTO communications_messages[\s\S]*cta_action/).map((c) => (c[1] as unknown[])[3]);
    expect(ctas).toContain("networth");
    expect(ctas).not.toContain("flinks");
    expect(ctas).not.toContain("cra");
  });

  it("the Request Items form list ignores the old automatic prompts", async () => {
    queryMock.mockImplementation(answerBySql([
      [/SELECT DISTINCT cta_action FROM communications_messages/, { rows: [{ cta_action: "networth" }] }],
    ]));
    const { getRequestedFormIds } = await import("../routes/clientDocumentsNeeded.js");
    expect(await getRequestedFormIds(APP_ID)).toEqual(["networth"]);
    const [sql, params] = callsMatching(queryMock, /SELECT DISTINCT cta_action FROM communications_messages/)[0]!;
    expect(sqlText(sql)).toContain(AUTO);
    expect(params).toEqual([APP_ID]);
  });

  it("staff Request Items treats only staff-requested Connect Bank / CRA prompts as already posted", async () => {
    queryMock.mockImplementation(answerBySql([
      [/SELECT id FROM applications WHERE id::text/, { rows: [{ id: APP_ID }] }],
      [/SELECT silo FROM applications/, { rows: [{ silo: "BF" }] }],
    ]));
    const router = (await import("../modules/applications/applications.routes.js")).default;
    const { errorHandler } = await import("../middleware/errors.js");
    const app = express();
    app.use(express.json());
    app.use("/api/applications", router);
    app.use(errorHandler);
    const res = await request(app).post(`/api/applications/${APP_ID}/request-steps`).set("Authorization", `Bearer ${staffToken()}`).send({ forms: ["cra", "flinks"] });
    expect(res.status).toBe(200);
    const [existing] = callsMatching(queryMock, /SELECT DISTINCT cta_action FROM communications_messages/)[0]!;
    expect(sqlText(existing)).toContain(AUTO);
    // The automatic prompts are not counted, so the staff request posts real buttons.
    expect(res.body.posted.forms).toEqual(["cra", "flinks"]);
  });

  it("the client thread hides an old automatic prompt (no staff name)", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM communications_messages/, { rows: [
        { id: "m1", direction: "outbound", body: "Complete the Connect Bank (View-Only) step to continue your application.", staff_name: null, cta_label: "Connect Bank (View-Only)", cta_action: "flinks", created_at: "2026-10-01T00:00:00Z" },
        { id: "m2", direction: "outbound", body: "Hi, just checking in.", staff_name: "Todd", cta_label: null, cta_action: null, created_at: "2026-10-02T00:00:00Z" },
      ] }],
    ]));
    const router = (await import("../routes/client/index.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/client", router);
    const res = await request(app).get(`/api/client/messages?applicationId=${APP_ID}`).set("Authorization", `Bearer ${staffToken()}`);
    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(["m2"]);
  });
});
