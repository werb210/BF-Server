// BF_SERVER_CONTACT_FORM_AUTOMATION_v1
import express from "express";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  queryMock: vi.fn(),
  sendTransactional: vi.fn(async () => ({ ok: true, status: 202 })),
  sendOne: vi.fn(async () => ({ ok: true })),
  notifyAllStaff: vi.fn(async () => undefined),
  contactResult: { row: { id: "ct 1/x" }, created: true } as { row: { id: string } | null; created: boolean },
}));
vi.mock("../../../db.js", () => ({ pool: { query: h.queryMock }, runQuery: h.queryMock }));
vi.mock("../../../services/sendgridService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/sendgridService.js")>()),
  sendgridConfigured: () => true,
  sendTransactional: h.sendTransactional,
  sendOne: h.sendOne,
}));
vi.mock("../../crm/crm.service.js", () => ({ createCrmLead: vi.fn(async () => ({ id: "lead-1" })) }));
vi.mock("../../continuation/continuation.service.js", () => ({ createContinuation: vi.fn(async () => undefined) }));
vi.mock("../../../services/companies.js", () => ({ findOrCreateCompanyByNameAndSilo: vi.fn(async () => ({ row: { id: "co-1" } })) }));
vi.mock("../../../services/contacts.js", () => ({ findOrCreateContactByEmailAndCompany: vi.fn(async () => h.contactResult) }));
vi.mock("../../../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: h.notifyAllStaff }));
vi.mock("../../automation/automationEngine.js", () => ({ emitAutomationEvent: vi.fn(async () => undefined) }));

const FORM = { companyName: "Acme", fullName: "Ann Lee", phone: "+15875550100", email: "Ann@Acme.test" };

async function submit(template: { subject: string | null; html: string | null; body: string | null } | null = { subject: "Thanks {{first_name}}", html: "<p>Hi {{first_name}} at {{company}}</p>", body: null }) {
  h.queryMock.mockImplementation(answerBySql([[/FROM marketing_template/, { rows: template ? [template] : [] }]]));
  const { submitContactForm } = await import("../contact.controller.js");
  const app = express();
  app.use(express.json());
  app.post("/contact", submitContactForm);
  const res = await request(app).post("/contact").send(FORM);
  expect(res.status).toBe(200);
  return res;
}

describe("contact form automation v1", () => {
  beforeEach(() => {
    h.queryMock.mockReset();
    h.sendTransactional.mockClear();
    h.sendOne.mockClear();
    h.notifyAllStaff.mockClear();
    h.contactResult = { row: { id: "ct 1/x" }, created: true };
  });

  it("tags the contact contact_form", async () => { // BF_SERVER_v856_CRM_UNIFY
    await submit();
    const tag = callsMatching(h.queryMock, /UPDATE contacts\s+SET tags/);
    expect(tag).toHaveLength(1);
    expect(String(tag[0]![0])).toContain("ARRAY['contact_form']");
    expect(String(tag[0]![0])).toContain("lower(email) = lower($1)");
    expect(tag[0]![1]).toEqual(["Ann@Acme.test"]);
  });

  // BF_SERVER_EMAIL_CHANNEL_TESTS_v2 - the autoresponder is one-to-one
  // operational mail and runs on sendTransactional, which disables click/open
  // tracking and carries no unsubscribe group. sendOne is the marketing sender.
  it("auto-sends the BF-After contact form template", async () => {
    await submit();
    expect(callsMatching(h.queryMock, /FROM marketing_template/)[0]![1]).toEqual(["BF-After contact form"]);
    expect(h.sendTransactional).toHaveBeenCalledWith({ to: "Ann@Acme.test", subject: "Thanks Ann", html: "<p>Hi Ann at Acme</p>", contactId: "ct 1/x" });
    expect(h.sendOne).not.toHaveBeenCalled();
  });

  it("skips the email when the template is missing", async () => {
    await submit(null);
    expect(h.sendTransactional).not.toHaveBeenCalled();
  });

  it("notification deep-links to the contact record", async () => {
    await submit();
    expect(h.notifyAllStaff).toHaveBeenCalledWith(expect.objectContaining({ contextUrl: `/crm/contacts/${encodeURIComponent("ct 1/x")}`, refId: "lead-1" }));
    h.notifyAllStaff.mockClear();
    h.contactResult = { row: null, created: false };
    await submit();
    expect(h.notifyAllStaff).toHaveBeenCalledWith(expect.objectContaining({ contextUrl: "/crm/contacts" }));
  });
});
