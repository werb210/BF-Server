// BF_SERVER_BLOCK_v547_CLIENT_REACTIVATE
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactivateHeldApplication } from "../clientReactivation.js";
import { ApplicationStage } from "../../modules/applications/pipelineState.js";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { APP_ID, PARAM_GUARD_RULE, buildV1App, clientToken } from "../../__tests__/helpers/v1AppsHarness.js";

const { queryMock, transition, staffSms } = vi.hoisted(() => ({ queryMock: vi.fn(), transition: vi.fn(async () => undefined), staffSms: vi.fn(async () => undefined) }));
vi.mock("../../db.js", () => ({
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));
vi.mock("../../modules/applications/applications.service.js", () => ({ transitionPipelineState: transition }));
vi.mock("../notifications/staffSms.js", () => ({ sendStaffNotification: staffSms }));

const CLAIM = /UPDATE applications\s+SET parked_previous_stage = NULL/;
const OWNERSHIP = /SELECT COUNT\(\*\)::text AS n FROM app_phones/;

const fakes = (onHold: boolean) => ({
  claim: vi.fn(async () => onHold),
  moveToInReview: vi.fn(async () => undefined),
  tellStaff: vi.fn(async () => undefined),
});

describe("v547 client reactivates an on-hold file", () => {
  it("moves a held file to In Review and tells staff", async () => {
    const d = fakes(true);
    expect(await reactivateHeldApplication("a1", d)).toEqual({ ok: true });
    expect(d.moveToInReview).toHaveBeenCalledWith("a1");
    expect(d.tellStaff).toHaveBeenCalledWith("a1");
  });
  it("does nothing to a file that is not on hold (including Fraud)", async () => {
    const d = fakes(false);
    expect(await reactivateHeldApplication("a1", d)).toEqual({ ok: false, error: "not_on_hold" });
    expect(d.moveToInReview).not.toHaveBeenCalled();
    expect(d.tellStaff).not.toHaveBeenCalled();
  });
  it("a failed staff notice does not undo the reactivation", async () => {
    const d = { ...fakes(true), tellStaff: vi.fn(async () => { throw new Error("sms down"); }) };
    expect(await reactivateHeldApplication("a1", d)).toEqual({ ok: true });
  });
  it("claims only a file still on Hold, atomically", async () => {
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql([[CLAIM, { rows: [], rowCount: 0 }]]));
    expect(await reactivateHeldApplication("a1")).toEqual({ ok: false, error: "not_on_hold" });
    const claim = callsMatching(queryMock, CLAIM);
    expect(claim).toHaveLength(1);
    expect(String(claim[0]![0])).toMatch(/WHERE id::text = \(\$1\)::text AND pipeline_state = \$2\s+RETURNING id/);
    expect(claim[0]![1]).toEqual(["a1", ApplicationStage.HOLD]);
    expect(transition).not.toHaveBeenCalled();
  });
  it("a claimed file moves to In Review through the pipeline transition", async () => {
    queryMock.mockReset();
    transition.mockClear();
    queryMock.mockImplementation(answerBySql([[CLAIM, { rows: [{ id: "a1" }], rowCount: 1 }]]));
    expect(await reactivateHeldApplication("a1")).toEqual({ ok: true });
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ applicationId: "a1", nextState: ApplicationStage.IN_REVIEW, trigger: "client_reactivated" }));
    expect(callsMatching(queryMock, /INSERT INTO communications_messages/)).toHaveLength(1);
    expect(staffSms).toHaveBeenCalledTimes(1);
  });
});

describe("v547 the route requires sign-in and ownership", () => {
  const url = `/api/client/applications/${APP_ID}/reactivate`;
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    transition.mockClear();
  });
  function db(owner: boolean, onHold: boolean) {
    queryMock.mockImplementation(
      answerBySql([
        PARAM_GUARD_RULE,
        [OWNERSHIP, { rows: [{ n: owner ? "1" : "0" }] }],
        [CLAIM, onHold ? { rows: [{ id: APP_ID }], rowCount: 1 } : { rows: [], rowCount: 0 }],
      ]),
    );
  }
  it("rejects an anonymous caller", async () => {
    db(true, true);
    const res = await request(await buildV1App()).post(url);
    expect(res.status).toBe(401);
    expect(callsMatching(queryMock, CLAIM)).toHaveLength(0);
  });
  it("hides a file the caller does not own", async () => {
    db(false, true);
    const res = await request(await buildV1App()).post(url).set("Authorization", `Bearer ${clientToken()}`);
    expect(res.status).toBe(404);
    expect(callsMatching(queryMock, CLAIM)).toHaveLength(0);
  });
  it("answers 409 for an owned file that is not on hold", async () => {
    db(true, false);
    const res = await request(await buildV1App()).post(url).set("Authorization", `Bearer ${clientToken()}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_on_hold");
  });
  it("reactivates an owned held file", async () => {
    db(true, true);
    const res = await request(await buildV1App()).post(url).set("Authorization", `Bearer ${clientToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, applicationId: APP_ID, pipeline_state: "In Review" });
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ applicationId: APP_ID }));
  });
  it("rejects a malformed id", async () => {
    db(true, true);
    const res = await request(await buildV1App()).post("/api/client/applications/not-an-id/reactivate").set("Authorization", `Bearer ${clientToken()}`);
    expect(res.status).toBe(400);
  });
});
