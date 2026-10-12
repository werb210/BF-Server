// BF_SERVER_v786_WORKFLOW_GRAPH - every trigger emitter fires through the one event bus, the
// timeline shows automation steps, and room recordings show on every participant's timeline.
// Each emitter is driven through the route / service / worker that fires it (see
// helpers/automationEmitters.ts) and the event it hands the engine is asserted.
import { beforeEach, describe, it, expect, vi } from "vitest";
import { callsMatching } from "./helpers/answerBySql.js";
import * as E from "./helpers/automationEmitters.js";

const h = vi.hoisted(() => ({
  q: vi.fn(),
  emit: vi.fn(async () => undefined),
  defaultDeps: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [] })) })),
  runDue: vi.fn(async () => 0),
  runEnrollment: vi.fn(async () => "completed"),
  buildContext: vi.fn(async (_q: unknown, ev: Record<string, unknown>) => ({ ...ev, built: true })),
  runDailyTriggers: vi.fn(async () => 0),
  enrollGraph: vi.fn(async () => "enr-1"),
  graphFetch: vi.fn(),
  biContactForPhone: vi.fn(async () => "ct-bi"),
}));

vi.mock("../db.js", async (importOriginal) => {
  const real: any = await importOriginal();
  const query = (sql: unknown, params?: unknown[]) => h.q(sql, params);
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { ...real, pool, db: pool, default: pool, runQuery: query, dbQuery: query, query };
});
vi.mock("../modules/automation/automationEngine.js", () => ({
  emitAutomationEvent: h.emit,
  runAutomations: h.emit,
  defaultDeps: h.defaultDeps,
  runDue: h.runDue,
  runEnrollment: h.runEnrollment,
  buildContext: h.buildContext,
}));
vi.mock("../modules/automation/graphEngine.js", () => ({
  runDailyTriggers: h.runDailyTriggers,
  convertV1Rules: vi.fn(async () => 0),
  enrollGraph: h.enrollGraph,
}));
vi.mock("../workers/claim.js", () => ({ claimedTick: (_name: string, fn: () => Promise<void>) => fn }));
vi.mock("../middleware/twilioWebhookValidation.js", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { twilioWebhookValidation: pass, validateTwilioWebhook: pass };
});
vi.mock("../services/contacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/contacts.js")>()),
  createContact: vi.fn(async () => ({ id: "ct-manual" })),
  findOrCreateContactByEmailAndCompany: vi.fn(async () => ({ row: { id: "ct-web" }, created: true })),
}));
vi.mock("../services/companies.js", () => ({ findOrCreateCompanyByNameAndSilo: vi.fn(async () => ({ row: { id: "co-1" } })) }));
vi.mock("../modules/crm/crm.service.js", () => ({ createCrmLead: vi.fn(async () => ({ id: "lead-1" })) }));
vi.mock("../modules/continuation/continuation.service.js", () => ({ createContinuation: vi.fn(async () => undefined) }));
vi.mock("../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: vi.fn(async () => undefined) }));
vi.mock("../services/sendgridService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/sendgridService.js")>()),
  sendgridConfigured: () => false,
}));
vi.mock("../modules/o365/contactSync.js", () => ({ pushContactToOutlook: vi.fn(async () => undefined) }));
vi.mock("../modules/o365/graphClient.js", () => ({ getGraphForUser: vi.fn(async () => ({ fetch: h.graphFetch })) }));
vi.mock("../services/teams/graphAppClient.js", () => ({ isAppGraphConfigured: () => false, graphAppFetch: vi.fn(async () => { throw new Error("graph not configured"); }) }));
vi.mock("../modules/audit/audit.service.js", () => ({ recordAuditEvent: vi.fn(async () => undefined) }));
vi.mock("../lib/storage/index.js", () => ({
  getStorage: () => ({ put: vi.fn(async () => ({ hash: "h1", blobName: "applications/x/june.pdf", url: "https://blob/june.pdf", sizeBytes: 6 })), get: vi.fn(async () => null) }),
}));
vi.mock("../services/documents/duplicateDocuments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/documents/duplicateDocuments.js")>()),
  assertNotDuplicate: vi.fn(async () => undefined),
}));
vi.mock("../modules/ocr/ocr.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../modules/ocr/ocr.service.js")>()),
  enqueueOcrForDocument: vi.fn(async () => undefined),
}));
vi.mock("../modules/applications/processingStage.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../modules/applications/processingStage.service.js")>()),
  setProcessingStage: vi.fn(async () => undefined),
}));
vi.mock("../services/biApplicantThread.js", () => ({
  cleanAttachments: () => [],
  biSendForPhone: vi.fn(async () => ({ id: "msg-bi" })),
  biContactForPhone: h.biContactForPhone,
}));
vi.mock("../services/team/teamPhaseC.js", () => ({ postTeamAlert: vi.fn(async () => undefined) }));

import { loadCrmTimeline } from "../routes/crm/timeline.js";
import { SENDGRID_TRIGGERS } from "../routes/sendgridWebhook.js";

const waitForEmit = (...args: unknown[]) => vi.waitFor(() => expect(h.emit).toHaveBeenCalledWith(...args));

describe("trigger emitters", () => {
  beforeEach(() => {
    h.emit.mockClear();
  });

  it("contact.created (website_form)", async () => {
    expect((await E.websiteContactForm(h.q)).status).toBe(200);
    await waitForEmit({ trigger: "contact.created", silo: "BF", contactId: "ct-web", data: { source: "website_form" } });
  });

  it("contact.created (booking) and booking.created", async () => {
    const { startsAt } = await E.clientBookingCreated(h.q);
    expect(h.emit).toHaveBeenCalledWith("contact.created", { silo: "BF", contactId: "ct-book", data: { source: "booking" } });
    expect(h.emit).toHaveBeenCalledWith("booking.created", {
      silo: "BF",
      contactId: "ct-book",
      data: { booking_id: expect.any(String), kind: "phone", starts_at: startsAt.toISOString(), staff_user_id: "u-todd" },
    });
  });

  it("contact.created (manual)", async () => {
    expect((await E.crmManualContact(h.q)).status).toBe(201);
    expect(h.emit).toHaveBeenCalledWith("contact.created", { silo: "BF", contactId: "ct-manual", data: { source: "manual" } });
  });

  it("contact.created (import) and contact.field_changed", async () => {
    const res = await E.crmImport(h.q);
    expect(res.body).toMatchObject({ ok: true, created: 1, updated: 1 });
    await waitForEmit("contact.created", { silo: "BF", contactId: "ct-new", data: { source: "import" } });
    await waitForEmit("contact.field_changed", { silo: "BF", contactId: "ct-old", data: { field: "phone", from: "5875550100", to: "5875550199", source: "import" } });
    // Unchanged fields are not reported.
    expect(h.emit).not.toHaveBeenCalledWith("contact.field_changed", expect.objectContaining({ data: expect.objectContaining({ field: "first_name" }) }));
  });

  it("contact.created (conference) and meeting.completed", async () => {
    const room = await E.conferenceCallerJoins(h.q);
    expect(h.emit).toHaveBeenCalledWith("contact.created", { silo: "BF", contactId: "ct-conf", data: { source: "conference", meeting_room_id: room.id } });
    await E.conferenceEnds(h.q);
    expect(h.emit).toHaveBeenCalledWith("meeting.completed", {
      silo: "BF",
      contactId: "ct-attendee",
      applicationId: null,
      data: { meeting_room_id: room.id, conference_id: "conf-1", title: room.title },
    });
  });

  it("application.created", async () => {
    await E.applicationCreated(h.q);
    await waitForEmit("application.created", { silo: "BF", applicationId: "app-new", data: { source: "client", product_type: "standard" } });
  });

  it("application.stage_changed", async () => {
    await E.applicationStageChanged(h.q);
    expect(h.emit).toHaveBeenCalledWith({ trigger: "application.stage_changed", applicationId: E.IDS.app, fromStage: "Received", toStage: "In Review" });
  });

  it("document.uploaded", async () => {
    await E.documentUploaded(h.q);
    await waitForEmit("document.uploaded", { applicationId: E.IDS.app, data: { document_id: expect.any(String), document_type: "bank_statements" } });
  });

  it("document.rejected (documents)", async () => {
    expect((await E.documentRejectedInDocuments(h.q)).status).toBe(200);
    await waitForEmit({ trigger: "document.rejected", applicationId: E.IDS.app, data: { document_id: E.IDS.doc } });
  });

  it("document.rejected (portal)", async () => {
    expect((await E.documentRejectedInPortal(h.q)).status).toBe(200);
    await waitForEmit({ trigger: "document.rejected", applicationId: E.IDS.app, data: { document_type: "Bank statements", reason: "blurry", document_id: E.IDS.doc } });
  });

  it("message.inbound (sms)", async () => {
    expect((await E.smsInbound(h.q)).status).toBe(200);
    await waitForEmit({ trigger: "message.inbound", silo: "BF", contactId: "ct-sms", data: { channel: "sms" } });
  });

  it("message.inbound (client portal)", async () => {
    await E.clientPortalMessage(h.q);
    await waitForEmit({ trigger: "message.inbound", applicationId: E.IDS.app, data: { channel: "client_portal" } });
  }, 60_000);

  it("message.inbound (BI app)", async () => {
    expect((await E.biApplicantMessage(h.q)).status).toBe(201);
    await waitForEmit({ trigger: "message.inbound", silo: "BI", contactId: "ct-bi", data: { channel: "client_portal" } });
  });

  it("message.inbound (O365 mail)", async () => {
    h.graphFetch.mockResolvedValue(new Response(JSON.stringify(E.MAIL_REPLY_GRAPH_MESSAGES), { status: 200 }));
    const worker = await E.mailReply(h.q);
    try {
      await waitForEmit("message.inbound", { silo: "BF", contactId: "ct-mail", data: { channel: "email" } });
    } finally {
      worker.stop();
    }
  });

  it("call.missed", async () => {
    expect((await E.missedCall(h.q)).status).toBe(201);
    await waitForEmit({ trigger: "call.missed", silo: "BF", contactId: "ct-call", applicationId: null });
  });

  it("link.clicked", async () => {
    const r = await E.trackedLinkClick(h.q);
    expect(r.status).toBe(302);
    await waitForEmit("link.clicked", { contactId: "c-1", data: { url: "https://boreal.financial/apply" } });
  });

  it("email.* (SendGrid)", async () => {
    expect((await E.sendgridEvent(h.q, { email: "ann@acme.test", contact_id: "ct-sg", event: "click", url: "https://boreal.financial/x" })).status).toBe(200);
    await waitForEmit("email.clicked", { contactId: "ct-sg", data: { email: "ann@acme.test", url: "https://boreal.financial/x" } });
  });

  it("SendGrid events map to the email triggers", () => {
    expect(SENDGRID_TRIGGERS).toEqual({ open: "email.opened", click: "email.clicked", bounce: "email.bounced", unsubscribe: "email.unsubscribed", group_unsubscribe: "email.unsubscribed" });
  });

  it("date.relative / no_reply (worker)", async () => {
    h.runDailyTriggers.mockClear();
    const worker = await E.automationWorkerTick(h.q);
    try {
      await vi.waitFor(() => expect(h.runDailyTriggers).toHaveBeenCalledTimes(1));
      const deps = await h.defaultDeps.mock.results[0]!.value;
      expect(h.runDailyTriggers).toHaveBeenCalledWith(deps);
    } finally {
      worker.stop();
    }
  });

  it("manual (enroll endpoint)", async () => {
    const res = await E.manualEnroll(h.q);
    expect(res.status).toBe(200);
    expect(h.buildContext).toHaveBeenCalledWith(expect.anything(), { trigger: "manual", silo: "BF", contactId: E.IDS.contact, applicationId: null, data: { source: "manual" } });
    expect(h.enrollGraph).toHaveBeenCalledTimes(1);
    expect(h.runEnrollment).toHaveBeenCalledWith(expect.anything(), "enr-1");
  });
});

describe("contact timeline", () => {
  it("shows automation steps and room recordings linked through call_recording_contacts", async () => {
    h.q.mockReset();
    h.q.mockImplementation(async () => ({ rows: [] }));
    await loadCrmTimeline(true, "c-1", "BF");
    const sql = String(h.q.mock.calls[0]![0]);
    expect(sql).toContain("'email_notice_sent','automation')");
    expect(sql).toContain("WHEN 'automation' THEN ('Automation: '");
    expect(sql).toContain("WHEN event_type = 'automation' THEN 'system'");
    expect(sql).toContain("EXISTS (SELECT 1 FROM call_recording_contacts rc WHERE rc.recording_id = cr.id AND rc.contact_id::text = $1::text)");
  });

  it("GET /api/crm/contacts/:id/calls includes recordings linked to the contact", async () => {
    expect((await E.crmContactCalls(h.q)).status).toBe(200);
    const calls = callsMatching(h.q, /FROM conferences cf/);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual([E.IDS.contact]);
    expect(String(calls[0]![0])).toContain("OR cf.id IN (SELECT r2.conference_id FROM call_recording_contacts rc JOIN call_recordings r2 ON r2.id = rc.recording_id WHERE rc.contact_id::text = $1)");
  });
});
