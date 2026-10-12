// BF_SERVER_TODO_PROMPTS_v635 (shipped as BF-Server v638)
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql } from "./helpers/answerBySql.js";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "+15875550123";
const PGI_URL = "https://pgi.example/apply/123";
const h = vi.hoisted(() => ({ query: vi.fn(), signed: false }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../services/termSheetSigned.js", async (orig) => ({ ...(await orig<any>()), termSheetSigned: async () => h.signed }));
vi.mock("../services/pgiStage.js", async (orig) => ({ ...(await orig<any>()), pgiStageFor: async () => "new_application" }));
vi.mock("../routes/clientDocumentsNeeded.js", async (orig) => ({
  ...(await orig<any>()),
  computeOutstandingDocs: async () => ({ required: [], stillNeeded: [], rejected: [] }),
  getRequestedFormIds: async () => [],
  getWaivedDocTypes: async () => new Set<string>(),
}));
vi.mock("../signnow/sba/sbaTrigger.js", async (orig) => ({ ...(await orig<any>()), isSbaApplication: async () => false }));
vi.mock("../signnow/sba/sbaOwners.js", async (orig) => ({ ...(await orig<any>()), resolveSbaOwners: async () => [{ index: 1 }, { index: 2 }] }));

import { buildActionCenter, sbaFormsMissing } from "../services/applicantActions.js";
import clientRouter from "../routes/client/index.js";

const PROMPTS = [
  { id: "p1", direction: "outbound", body: "Please complete your PGI application", staff_name: null, cta_label: "Complete PGI Application", cta_action: PGI_URL, created_at: "2026-10-01T00:00:00Z" },
  { id: "p2", direction: "outbound", body: "Please fill in the SBA forms", staff_name: "Todd", cta_label: "SBA forms", cta_action: "sba_forms", created_at: "2026-10-01T00:01:00Z" },
  { id: "p3", direction: "outbound", body: "SBA forms again", staff_name: "Todd", cta_label: "SBA forms", cta_action: "form:sba_forms", created_at: "2026-10-01T00:02:00Z" },
  { id: "m1", direction: "outbound", body: "Thanks, we have everything", staff_name: "Todd", cta_label: null, cta_action: null, created_at: "2026-10-01T00:03:00Z" },
];

beforeEach(() => {
  h.signed = false;
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [{ id: APP }] }],
    [/WITH app_phones AS/, { rows: [{ total: 1, mine: 1, known: 1 }] }],
    [/WITH thread AS/, { rows: PROMPTS }],
    [/SELECT cta_label, cta_action FROM communications_messages/, { rows: [{ cta_label: "Complete PGI Application", cta_action: PGI_URL }, { cta_label: "SBA forms", cta_action: "sba_forms" }] }],
    [/SELECT doc_type FROM application_form_responses/, { rows: [{ doc_type: "sba_form_1919" }] }],
  ]));
});

describe("SBA forms outstanding", () => {
  it("needs the 1919 and a 413 per owner", () => {
    expect(sbaFormsMissing([1, 2], ["sba_form_1919", "sba_form_413"])).toEqual(["sba_form_413_owner_2"]);
    expect(sbaFormsMissing([1], ["sba_form_1919", "sba_form_413"])).toEqual([]);
  });
});

describe("PGI and SBA prompts leave the chat for the to-do list", () => {
  it("action center adds the SBA forms item, and the PGI item only once a term sheet is signed", async () => {
    const before = await buildActionCenter(APP);
    expect(before.outstanding.find((i) => i.key === "pgi")).toBeUndefined();
    expect(before.outstanding).toContainEqual({ key: "form:sba_forms", kind: "form", label: "SBA forms", action: "sba_forms", urgent: false });

    h.signed = true;
    const after = await buildActionCenter(APP);
    expect(after.outstanding).toContainEqual(expect.objectContaining({ key: "pgi", kind: "action", action: PGI_URL, urgent: true }));
  });

  it("the client thread leaves them out", async () => {
    h.signed = true;
    const app = express();
    app.use(express.json());
    app.use("/api/client", clientRouter);
    const token = "Bearer " + jwt.sign({ sub: "client:" + OWNER, role: "client", phone: OWNER, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
    const r = await request(app).get(`/api/client/messages?applicationId=${APP}`).set("Authorization", token);
    expect(r.status).toBe(200);
    expect(r.body.data.map((m: any) => m.id)).toEqual(["m1"]);
  });
});
