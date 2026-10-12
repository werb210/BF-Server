// BF_SERVER_SBA_FORM_REQUEST_v141
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../../db", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock, dbQuery: queryMock };
});
vi.mock("../../../services/notifications/notifyClient.js", () => ({ notifyClient: vi.fn(async () => ({ channel: "sms" })) }));
vi.mock("../../../signnow/sba/sbaOwners.js", async (orig) => ({
  ...(await orig<typeof import("../../../signnow/sba/sbaOwners.js")>()),
  resolveSbaOwners: vi.fn(async () => [{ index: 1, fullName: "Jane Roe", email: "jane@example.com" }]),
}));

const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const token = () => jwt.sign({ sub: "00000000-0000-4000-8000-0000000000b1", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

async function requestSteps(body: Record<string, unknown>) {
  const router = (await import("../applications.routes.js")).default;
  const { errorHandler } = await import("../../../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use("/api/applications", router);
  app.use(errorHandler);
  return request(app).post(`/api/applications/${APP_ID}/request-steps`).set("Authorization", `Bearer ${token()}`).send(body);
}

const prompts = () => callsMatching(queryMock, /INSERT INTO communications_messages[\s\S]*cta_action/).map((c) => c[1] as unknown[]);
const uploadRequests = () => callsMatching(queryMock, /INSERT INTO application_document_requests/);

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([[/SELECT id FROM applications WHERE id::text/, { rows: [{ id: APP_ID }] }]]));
});

describe("every spelling of the SBA forms is accepted", () => {
  it.each(["sba1919", "sba413", "sba_form_1919", "sba_form_413", "SBA_FORM_413"])("%s resolves", async (key) => {
    const res = await requestSteps({ forms: [key] });
    expect(res.status).toBe(200);
    expect(res.body.posted.forms).toEqual(["sba_forms"]);
    expect(prompts().map((p) => p[3])).toEqual(["sba_forms"]);
  });

  it("per-owner 413 keys resolve to the same page", async () => {
    const res = await requestSteps({ forms: ["sba_form_413_owner_3"] });
    expect(res.body.posted.forms).toEqual(["sba_forms"]);
  });

  it("an unknown form is dropped rather than posted", async () => {
    const res = await requestSteps({ forms: ["not_a_form"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_steps");
    expect(prompts()).toHaveLength(0);
  });
});

describe("an SBA form is never posted as an upload", () => {
  it("is filtered out of the documents list and becomes a form prompt instead of being dropped", async () => {
    const res = await requestSteps({ documents: ["sba_form_413", "Void cheque"] });
    expect(res.status).toBe(200);
    expect(res.body.posted.documents).toEqual(["Void cheque"]);
    expect(res.body.posted.forms).toEqual(["sba_forms"]);
    expect(uploadRequests().map((c) => (c[1] as unknown[])[1])).toEqual(["Void cheque"]);
  });

  it("an SBA-only documents list still posts the form", async () => {
    const res = await requestSteps({ documents: ["sba_form_1919"] });
    expect(res.status).toBe(200);
    expect(res.body.posted).toMatchObject({ forms: ["sba_forms"], documents: [] });
    expect(uploadRequests()).toHaveLength(0);
  });
});

describe("one prompt, not one per owner", () => {
  it("all SBA keys collapse to a single cta", async () => {
    const res = await requestSteps({ forms: ["sba1919", "sba413", "sba_form_1919", "sba_form_413", "sba_form_413_owner_2", "sba_forms"] });
    expect(res.body.posted.forms).toEqual(["sba_forms"]);
    expect(prompts()).toHaveLength(1);
  });

  it("the label is generic, because the page lists whatever is outstanding", async () => {
    await requestSteps({ forms: ["sba_form_413_owner_2"] });
    const [p] = prompts();
    expect(p).toEqual([APP_ID, "Please complete the SBA Forms step to continue your application.", "SBA Forms", "sba_forms"]);
  });

  it("an already-posted SBA prompt is not posted again", async () => {
    queryMock.mockImplementation(answerBySql([
      [/SELECT id FROM applications WHERE id::text/, { rows: [{ id: APP_ID }] }],
      [/SELECT DISTINCT cta_action FROM communications_messages/, { rows: [{ cta_action: "sba_forms" }] }],
    ]));
    const res = await requestSteps({ forms: ["sba413"] });
    expect(res.body.posted).toMatchObject({ forms: [], formsSkipped: ["sba_forms"] });
    expect(prompts()).toHaveLength(0);
  });
});

describe("why it mattered", () => {
  it("signing waits on form responses that could not be created", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM lender_submissions s/, { rows: [{ n: "1" }] }],
      [/jsonb_array_length\(metadata->'sba_signnow'\)/, { rows: [{ n: "0" }] }],
    ]));
    const { maybeStartSbaSigning } = await import("../../../signnow/sba/sbaTrigger.js");
    expect(await maybeStartSbaSigning(APP_ID)).toEqual({ started: false, reason: "waiting_on:sba_form_1919,sba_form_413" });
  });
});
