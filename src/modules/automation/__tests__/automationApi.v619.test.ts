// BF_SERVER_BLOCK_v619 - automation API validation and trigger wiring.
// The phase-1 trigger points are driven through the routes / services that fire them
// (see src/__tests__/helpers/automationEmitters.ts); the event each hands the engine is asserted.
import { beforeEach, describe, it, expect, vi } from "vitest";
import { validateSteps } from "../../../routes/automations.js";
import * as E from "../../../__tests__/helpers/automationEmitters.js";

const h = vi.hoisted(() => ({ q: vi.fn(), emit: vi.fn(async () => undefined) }));

vi.mock("../../../db.js", async (importOriginal) => {
  const real: any = await importOriginal();
  const query = (sql: unknown, params?: unknown[]) => h.q(sql, params);
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { ...real, pool, db: pool, default: pool, runQuery: query, dbQuery: query, query };
});
vi.mock("../automationEngine.js", () => ({ emitAutomationEvent: h.emit, runAutomations: h.emit }));
vi.mock("../../../middleware/twilioWebhookValidation.js", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { twilioWebhookValidation: pass, validateTwilioWebhook: pass };
});
vi.mock("../../../services/contacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/contacts.js")>()),
  findOrCreateContactByEmailAndCompany: vi.fn(async () => ({ row: { id: "ct-web" }, created: true })),
}));
vi.mock("../../../services/companies.js", () => ({ findOrCreateCompanyByNameAndSilo: vi.fn(async () => ({ row: { id: "co-1" } })) }));
vi.mock("../../crm/crm.service.js", () => ({ createCrmLead: vi.fn(async () => ({ id: "lead-1" })) }));
vi.mock("../../continuation/continuation.service.js", () => ({ createContinuation: vi.fn(async () => undefined) }));
vi.mock("../../../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: vi.fn(async () => undefined) }));
vi.mock("../../../services/sendgridService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/sendgridService.js")>()),
  sendgridConfigured: () => false,
}));
vi.mock("../../audit/audit.service.js", () => ({ recordAuditEvent: vi.fn(async () => undefined) }));
vi.mock("../../applications/processingStage.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../applications/processingStage.service.js")>()),
  setProcessingStage: vi.fn(async () => undefined),
}));
vi.mock("../../../services/biApplicantThread.js", () => ({
  cleanAttachments: () => [],
  biSendForPhone: vi.fn(async () => ({ id: "msg-bi" })),
  biContactForPhone: vi.fn(async () => "ct-bi"),
}));
vi.mock("../../../services/team/teamPhaseC.js", () => ({ postTeamAlert: vi.fn(async () => undefined) }));

const waitForEmit = (ev: Record<string, unknown>) => vi.waitFor(() => expect(h.emit).toHaveBeenCalledWith(ev));

describe("automation API", () => {
  it("validates steps", () => {
    expect(validateSteps([{ type: "wait", amount: 0 }])).toMatch(/wait needs an amount/);
    expect(validateSteps([{ type: "launch_rocket" }])).toMatch(/unknown type/);
    expect(validateSteps([{ type: "send_sms", body: " " }])).toMatch(/text needs a message/);
    expect(validateSteps([{ type: "check", check: "still_in_stage" }, { type: "create_task", title: "ok" }])).toBeNull();
  });
});

describe("trigger points fire from every phase-1 trigger", () => {
  beforeEach(() => h.emit.mockClear());

  it("document.rejected from the portal", async () => {
    await E.documentRejectedInPortal(h.q);
    await waitForEmit({ trigger: "document.rejected", applicationId: E.IDS.app, data: { document_type: "Bank statements", reason: "blurry", document_id: E.IDS.doc } });
  });

  it("document.rejected from the documents route", async () => {
    await E.documentRejectedInDocuments(h.q);
    await waitForEmit({ trigger: "document.rejected", applicationId: E.IDS.app, data: { document_id: E.IDS.doc } });
  });

  it("message.inbound from SMS", async () => {
    await E.smsInbound(h.q);
    await waitForEmit({ trigger: "message.inbound", silo: "BF", contactId: "ct-sms", data: { channel: "sms" } });
  });

  it("message.inbound from the client portal", async () => {
    await E.clientPortalMessage(h.q);
    await waitForEmit({ trigger: "message.inbound", applicationId: E.IDS.app, data: { channel: "client_portal" } });
  }, 60_000);

  it("message.inbound from the BI applicant thread", async () => {
    await E.biApplicantMessage(h.q);
    await waitForEmit({ trigger: "message.inbound", silo: "BI", contactId: "ct-bi", data: { channel: "client_portal" } });
  });

  it("call.missed", async () => {
    await E.missedCall(h.q);
    await waitForEmit({ trigger: "call.missed", silo: "BF", contactId: "ct-call", applicationId: null });
  });

  it("contact.created from the website form", async () => {
    await E.websiteContactForm(h.q);
    await waitForEmit({ trigger: "contact.created", silo: "BF", contactId: "ct-web", data: { source: "website_form" } });
  });

  it("application.stage_changed", async () => {
    await E.applicationStageChanged(h.q);
    expect(h.emit).toHaveBeenCalledWith({ trigger: "application.stage_changed", applicationId: E.IDS.app, fromStage: "Received", toStage: "In Review" });
  });
});
