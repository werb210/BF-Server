// BF_SERVER_BLOCK_v452_SEND_BLOCKERS
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, progressMock, readinessMock, dispatchMock } = vi.hoisted(() => ({
  queryMock: vi.fn(), progressMock: vi.fn(), readinessMock: vi.fn(), dispatchMock: vi.fn(),
}));
vi.mock("../db.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), pool: { query: queryMock } }));
vi.mock("../services/submission/orchestrator.js", () => ({ progressSubmission: progressMock, readReadinessSnapshot: readinessMock }));
vi.mock("../services/productQuestions/sendGate.js", () => ({ productQuestionsSummary: vi.fn(async () => ({ blocking: false })) }));
vi.mock("../services/lenders/dispatchToSelected.js", () => ({ dispatchToSelected: dispatchMock }));

const STAFF = "00000000-0000-4000-8000-0000000000a1";
const APP = "aaaaaaaa-1111-4222-8333-444444444444";
const token = () => jwt.sign({ sub: STAFF, id: STAFF, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const GREEN = { allDocsAccepted: true, allTasksComplete: true, collateralRequired: false, collateralComplete: true, creditSummarySubmitted: true, applicationSigned: true };

async function app() {
  const router = (await import("../routes/submissionOrchestration.js")).default;
  const a = express();
  a.use(express.json());
  a.use("/api", router);
  return a;
}
const SENDS: Array<[string, Record<string, unknown>]> = [
  ["/api/lenders/send", { applicationId: APP, lenderIds: ["l1", "l2"] }],
  [`/api/applications/${APP}/lenders/send`, { lenderIds: ["l1", "l2"] }],
];

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([]));
  progressMock.mockReset();
  readinessMock.mockReset();
  readinessMock.mockResolvedValue(GREEN);
  dispatchMock.mockReset();
});

describe("v452 lender send blockers", () => {
  it.each(SENDS)("%s returns an all-failed dispatch as a blocker", async (path, body) => {
    progressMock.mockResolvedValue({ stageA: {}, stageB: { fired: false, reason: "dispatch_all_failed:smtp_down" } });
    const res = await request(await app()).post(path).set("Authorization", `Bearer ${token()}`).send(body);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "not_ready_to_send", reason: "dispatch_all_failed:smtp_down", blockers: ["dispatch_all_failed:smtp_down"], finalized: ["l1", "l2"] });
  });

  it.each(SENDS)("%s still names readiness blockers, and treats already-sent as success", async (path, body) => {
    readinessMock.mockResolvedValue({ ...GREEN, applicationSigned: false });
    progressMock.mockResolvedValue({ stageA: {}, stageB: { fired: false, reason: "preconditions_not_met" } });
    const blocked = await request(await app()).post(path).set("Authorization", `Bearer ${token()}`).send(body);
    expect(blocked.status).toBe(409);
    expect(blocked.body.blockers).toEqual(["application_not_signed"]);

    progressMock.mockResolvedValue({ stageA: {}, stageB: { fired: false, reason: "already_sent" } });
    expect((await request(await app()).post(path).set("Authorization", `Bearer ${token()}`).send(body)).status).toBe(200);
  });

  it.each(SENDS)("%s does not bypass the orchestrator with a second direct dispatch", async (path, body) => {
    progressMock.mockResolvedValue({ stageA: {}, stageB: { fired: true, sentTo: ["l1"] } });
    const res = await request(await app()).post(path).set("Authorization", `Bearer ${token()}`).send(body);
    expect(res.status).toBe(200);
    expect(progressMock).toHaveBeenCalledTimes(1);
    expect(progressMock.mock.calls[0]![0]).toMatchObject({ applicationId: APP });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(callsMatching(queryMock, /INSERT INTO application_lender_selections/).map((c) => (c[1] as unknown[]).slice(1))).toEqual([["l1", 0], ["l2", 1]]);
  });

  it("the per-application route reports who the orchestrator sent to", async () => {
    progressMock.mockResolvedValue({ stageA: {}, stageB: { fired: true, sentTo: ["l1"] } });
    const res = await request(await app()).post(`/api/applications/${APP}/lenders/send`).set("Authorization", `Bearer ${token()}`).send({ lenderIds: ["l1", "l2"] });
    expect(res.body).toMatchObject({ ok: true, finalized: ["l1", "l2"], sent: ["l1"] });
  });
});
