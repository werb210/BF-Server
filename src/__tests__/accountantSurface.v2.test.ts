import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNTANT_ALWAYS_AVAILABLE,
  ACCOUNTANT_DOC_CATEGORIES,
  isAccountantVisible,
  normaliseCategory,
} from "../routes/accountant.js";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  queryMock: vi.fn(),
  sendTransactional: vi.fn(async () => ({ ok: true, status: 202 })),
  sendOne: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../db.js", () => ({ pool: { query: h.queryMock }, runQuery: h.queryMock }));
vi.mock("../routes/clientDocumentsNeeded.js", () => ({
  computeOutstandingDocs: vi.fn(async () => ({ stillNeeded: [], rejected: [], required: [{ document_type: "3 years business tax returns" }, { document_type: "Cheque images" }] })),
}));
vi.mock("../services/sendgridService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/sendgridService.js")>()),
  sendgridConfigured: () => true,
  sendTransactional: h.sendTransactional,
  sendOne: h.sendOne,
}));
vi.mock("../modules/crm/crm.service.js", () => ({ createCrmLead: vi.fn(async () => ({ id: "lead-1" })) }));
vi.mock("../modules/continuation/continuation.service.js", () => ({ createContinuation: vi.fn(async () => undefined) }));
vi.mock("../services/companies.js", () => ({ findOrCreateCompanyByNameAndSilo: vi.fn(async () => ({ row: { id: "co-1" } })) }));
vi.mock("../services/contacts.js", () => ({ findOrCreateContactByEmailAndCompany: vi.fn(async () => ({ row: { id: "ct-1" }, created: false })) }));
vi.mock("../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: vi.fn(async () => undefined) }));

const CONTACT = "acc-contact-1";
const APP = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
const token = () => jwt.sign({ role: "accountant", contactId: CONTACT }, String(process.env.JWT_SECRET));

async function accountantApp() {
  const { default: router } = await import("../routes/accountant.js");
  const app = express();
  app.use("/api/accountant", router);
  return app;
}

describe("BF_SERVER_ACCOUNTANT_SURFACE_v2 routes", () => {
  beforeEach(() => h.queryMock.mockReset());

  it("serves the two endpoints the client calls on sign-in", async () => {
    h.queryMock.mockImplementation(
      answerBySql([
        [/FROM contacts WHERE id::text/, { rows: [{ id: CONTACT, first_name: "Al", last_name: "Count", email: "al@cpa.test", phone: null }], rowCount: 1 }],
        [/FROM accountant_invites ai\s+JOIN applications a/, { rows: [{ id: APP, business_name: "Acme" }] }],
        [/FROM applications a\s+JOIN accountant_invites ai/, { rows: [{ id: APP, business_name: "Acme" }], rowCount: 1 }],
      ]),
    );
    const app = await accountantApp();
    const me = await request(app).get("/api/accountant/me").set("Authorization", `Bearer ${token()}`);
    expect(me.status).toBe(200);
    expect(me.body.data).toEqual({ accountant: { id: CONTACT, name: "Al Count", email: "al@cpa.test", phone: null }, applications: [{ id: APP, business_name: "Acme" }] });
    const one = await request(app).get(`/api/accountant/applications/${APP}`).set("Authorization", `Bearer ${token()}`);
    expect(one.status).toBe(200);
    // Only allow-listed categories reach the accountant.
    expect(one.body.data.uploads).toEqual([{ category: "3 years business tax returns", outstanding: true }]);
    expect((await request(app).get("/api/accountant/me")).status).toBe(401);
  });

  it("scopes both to invitations for the contact on the token", async () => {
    h.queryMock.mockImplementation(
      answerBySql([[/FROM contacts WHERE id::text/, { rows: [{ id: CONTACT }], rowCount: 1 }], [/JOIN accountant_invites ai/, { rows: [], rowCount: 0 }]]),
    );
    const app = await accountantApp();
    await request(app).get("/api/accountant/me").set("Authorization", `Bearer ${token()}`);
    const list = callsMatching(h.queryMock, /FROM accountant_invites ai\s+JOIN applications a/);
    expect(String(list[0]![0])).toContain("WHERE ai.contact_id::text = ($1)::text");
    expect(list[0]![1]).toEqual([CONTACT]);

    const res = await request(app).get(`/api/accountant/applications/${APP}`).set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(404);
    const owned = callsMatching(h.queryMock, /FROM applications a\s+JOIN accountant_invites ai/);
    expect(String(owned[0]![0])).toContain("AND ai.contact_id::text = ($2)::text");
    expect(owned[0]![1]).toEqual([APP, CONTACT]);
  });
});

describe("BF_SERVER_ACCOUNTANT_SURFACE_v2 permissions", () => {
  it("denies by default rather than allowing by default", () => {
    expect(isAccountantVisible("something nobody has thought of")).toBe(false);
    expect(isAccountantVisible("Cheque images")).toBe(false);
  });

  it("allows the categories on the list", () => {
    expect(isAccountantVisible("6 months business banking statements")).toBe(true);
    expect(isAccountantVisible("3 years business tax returns")).toBe(true);
    expect(isAccountantVisible("A/R")).toBe(true);
  });

  it("matches the interim statements despite the dash the database stores", () => {
    expect(isAccountantVisible("PnL \u2014 Interim financials")).toBe(true);
    expect(isAccountantVisible("Balance Sheet \u2013 Interim financials")).toBe(true);
  });

  it("keeps applicant-only documents away from the accountant", () => {
    expect(isAccountantVisible("Personal net worth statement")).toBe(false);
    expect(isAccountantVisible("2 pieces of Government Issued ID")).toBe(false);
    expect(isAccountantVisible("Purchase Order or Invoice of Equipment to finance")).toBe(false);
  });

  it("rejects empty and non-string categories", () => {
    expect(isAccountantVisible("")).toBe(false);
    expect(isAccountantVisible(null)).toBe(false);
  });

  it("offers the three categories no lender product lists", () => {
    expect(ACCOUNTANT_ALWAYS_AVAILABLE).toContain("2 years personal tax returns (T1 generals)");
    expect(ACCOUNTANT_ALWAYS_AVAILABLE).toContain("Lease agreement");
    expect(ACCOUNTANT_ALWAYS_AVAILABLE).toContain("Real estate collateral");
    expect(ACCOUNTANT_ALWAYS_AVAILABLE).not.toContain("Other");
  });

  it("has no duplicate categories", () => {
    const keys = ACCOUNTANT_DOC_CATEGORIES.map(normaliseCategory);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("BF_SERVER_ACCOUNTANT_SURFACE_v2 contact autoresponder", () => {
  it("sends the acknowledgement down the transactional path", async () => {
    h.queryMock.mockReset();
    h.queryMock.mockImplementation(answerBySql([[/FROM marketing_template/, { rows: [{ subject: "Thanks", html: "<p>Hi</p>", body: null }] }]]));
    const { submitContactForm } = await import("../modules/website/contact.controller.js");
    const app = express();
    app.use(express.json());
    app.post("/contact", submitContactForm);
    const res = await request(app).post("/contact").send({ companyName: "Acme", fullName: "Ann Lee", phone: "+15875550100", email: "ann@acme.test" });
    expect(res.status).toBe(200);
    expect(h.sendTransactional).toHaveBeenCalledTimes(1);
    expect(h.sendTransactional).toHaveBeenCalledWith(expect.objectContaining({ to: "ann@acme.test" }));
    expect(h.sendOne).not.toHaveBeenCalled();
  });
});
