// BF_SERVER_STEP5_ACCOUNTANT_v1
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "+15875550123";
const h = vi.hoisted(() => ({
  query: vi.fn(),
  company: vi.fn(),
  contact: vi.fn(),
  invite: vi.fn(async () => ({ sent: true })),
}));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../services/companies.js", async (orig) => ({ ...(await orig<any>()), findOrCreateCompanyByNameAndSilo: h.company }));
vi.mock("../services/contacts.js", async (orig) => ({ ...(await orig<any>()), findOrCreateContactByEmailAndCompany: h.contact }));
vi.mock("../services/accountantInvite.js", async (orig) => ({ ...(await orig<any>()), sendAccountantInvite: h.invite }));

import clientRouter from "../routes/client/index.js";
import { ROUTES } from "../routes/routeRegistry.js";

const app = express();
app.use(express.json());
app.use("/api/client", clientRouter);
const token = "Bearer " + jwt.sign({ sub: "client:" + OWNER, role: "client", phone: OWNER, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const FIELDS = { applicationId: APP, firm: "Numbers LLP", contact: "Pat Q Accountant", email: "pat@numbers.example", phone: "403-523-0199" };
const capture = (body: Record<string, unknown>) => request(app).post("/api/client/accountant").set("Authorization", token).send(body);

beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [{ id: APP }] }],
    [/WITH app_phones AS/, { rows: [{ total: 1, mine: 1, known: 1 }] }],
  ]));
  h.company.mockReset();
  h.company.mockResolvedValue({ row: { id: "co-1" }, created: true });
  h.contact.mockReset();
  h.contact.mockResolvedValue({ row: { id: "ct-1" }, created: true });
  h.invite.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("BF_SERVER_STEP5_ACCOUNTANT_v1", () => {
  it("is mounted under the client router", async () => {
    const r = await capture(FIELDS);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, contactId: "ct-1" });
    expect(ROUTES).toContainEqual({ method: "POST", path: "/api/client/accountant", roles: [] });
  });

  it("merges only the cpa slot and never marks the advisors form submitted", async () => {
    await capture(FIELDS);
    const writes = callsMatching(h.query, "application_form_responses");
    expect(writes).toHaveLength(1);
    const sql = sqlText(writes[0]![0]);
    expect(sql).toContain("'{advisors,cpa}'");
    expect(sql).not.toContain("submitted_at");
    const params = writes[0]![1] as unknown[];
    expect(params.slice(0, 2)).toEqual([APP, "professional_advisors"]);
    expect(JSON.parse(String(params[2]))).toEqual({ firm: "Numbers LLP", contact: "Pat Q Accountant", email: "pat@numbers.example", phone: "403-523-0199" });
  });

  it("reuses the Stage-2 CRM mirror and its role tag", async () => {
    await capture(FIELDS);
    expect(h.company).toHaveBeenCalledWith(expect.anything(), "Numbers LLP", "BF", expect.objectContaining({ name: "Numbers LLP", silo: "BF" }));
    expect(h.contact).toHaveBeenCalledWith(expect.anything(), "pat@numbers.example", "co-1", "BF",
      expect.objectContaining({ first_name: "Pat", last_name: "Q Accountant", email: "pat@numbers.example", phone: "403-523-0199", company_id: "co-1" }));
    const [tag] = callsMatching(h.query, /UPDATE contacts\s+SET tags/);
    expect(tag![1]).toEqual(["ct-1", ["Accountant/advisor"], "403-523-0199", "pat@numbers.example"]);
    await vi.waitFor(() => expect(h.invite).toHaveBeenCalledWith(expect.objectContaining({ applicationId: APP, contactId: "ct-1", accountantEmail: "pat@numbers.example" })));
  });

  it("requires every field the modal collects", async () => {
    const noApp = await capture({ ...FIELDS, applicationId: "" });
    expect(noApp.status).toBe(400);
    expect(noApp.body).toEqual({ error: "applicationId_required" });
    for (const field of ["firm", "contact", "email", "phone"]) {
      const r = await capture({ ...FIELDS, [field]: "  " });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "accountant_fields_required" });
    }
    expect(callsMatching(h.query, "application_form_responses")).toHaveLength(0);
  });

  it("does not let a CRM failure break the capture", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.company.mockRejectedValue(new Error("companies table locked"));
    const r = await capture(FIELDS);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, contactId: null });
    expect(callsMatching(h.query, "application_form_responses")).toHaveLength(1);
    expect(warn.mock.calls.some((c) => c[0] === "[client.accountant] crm mirror failed")).toBe(true);
    expect(h.invite).not.toHaveBeenCalled();
  });
});
