// BF_SERVER_v786_WORKFLOW_GRAPH - every trigger emitter fires through the one event bus, the
// timeline shows automation steps, and room recordings show on every participant's timeline.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const q = vi.fn(async (sql: string, _p: any[] = []) => {
  if (sql.includes("SELECT contact_id FROM sms_campaign_sends")) return { rows: [{ contact_id: "c-1" }] };
  return { rows: [] };
});
vi.mock("../db.js", () => ({ pool: { query: (sql: string, p?: unknown[]) => q(sql, p as any[]) } }));
const emitAutomationEvent = vi.fn(async () => undefined);
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: (...a: any[]) => (emitAutomationEvent as any)(...a) }));

import { loadCrmTimeline } from "../routes/crm/timeline.js";
import smsRedirect from "../routes/smsRedirect.js";
import { SENDGRID_TRIGGERS } from "../routes/sendgridWebhook.js";

const src = (p: string) => readFileSync(p, "utf8");

describe("trigger emitters", () => {
  const cases: Array<[string, string, string]> = [
    ["contact.created (website_form)", "src/modules/website/contact.controller.ts", 'data: { source: "website_form" }'],
    ["contact.created (readiness_check)", "src/routes/creditReadiness.ts", 'data: { source: "readiness_check" }'],
    ["contact.created (booking)", "src/services/clientBooking.ts", 'emitAutomationEvent("contact.created", { silo: "BF", contactId, data: { source: "booking" } })'],
    ["contact.created (manual)", "src/routes/crm.ts", 'emitAutomationEvent("contact.created", { silo, contactId: String(row.id), data: { source: "manual" } })'],
    ["contact.created (import)", "src/routes/crm.ts", 'emitAutomationEvent("contact.created", { silo, contactId: cid, data: { source: "import" } })'],
    ["contact.created (conference)", "src/services/meetingRoomConference.ts", 'emitAutomationEvent("contact.created", { silo: room.silo, contactId, data: { source: "conference"'],
    ["contact.field_changed", "src/routes/crm.ts", 'emitAutomationEvent("contact.field_changed", { silo, contactId, data: { field, from, to, source } })'],
    ["application.created", "src/modules/applications/applications.repo.ts", 'm.emitAutomationEvent("application.created"'],
    ["application.stage_changed", "src/modules/applications/applications.service.ts", 'trigger: "application.stage_changed"'],
    ["document.uploaded", "src/routes/documents.ts", 'm.emitAutomationEvent("document.uploaded"'],
    ["document.rejected (portal)", "src/routes/portal.ts", 'trigger: "document.rejected"'],
    ["document.rejected (documents)", "src/routes/documents.ts", 'trigger: "document.rejected"'],
    ["booking.created", "src/services/clientBooking.ts", 'emitAutomationEvent("booking.created"'],
    ["meeting.completed", "src/services/meetingRoomConference.ts", 'emitAutomationEvent("meeting.completed"'],
    ["message.inbound (sms)", "src/routes/smsInboundWebhook.ts", 'data: { channel: "sms" }'],
    ["message.inbound (client portal)", "src/routes/client/index.ts", 'data: { channel: "client_portal" }'],
    ["message.inbound (BI app)", "src/routes/serviceBridge.ts", 'data: { channel: "client_portal" }'],
    ["message.inbound (O365 mail)", "src/workers/mailReplyWorker.ts", 'mod.emitAutomationEvent("message.inbound", { silo: contact.silo || "BF", contactId: String(contact.id), data: { channel: "email" } })'],
    ["call.missed", "src/routes/communications.ts", 'trigger: "call.missed"'],
    ["link.clicked", "src/routes/smsRedirect.ts", 'm.emitAutomationEvent("link.clicked"'],
    ["email.* (SendGrid)", "src/routes/sendgridWebhook.ts", "m.emitAutomationEvent(automationType"],
    ["date.relative / no_reply (worker)", "src/workers/automationWorker.ts", "graph.runDailyTriggers(deps)"],
    ["manual (enroll endpoint)", "src/routes/automations.ts", 'router.post("/:id/enroll", enrollers'],
  ];
  for (const [name, file, needle] of cases) it(`${name} fires from ${file}`, () => expect(src(file)).toContain(needle));

  it("SendGrid events map to the email triggers", () => {
    expect(SENDGRID_TRIGGERS).toEqual({ open: "email.opened", click: "email.clicked", bounce: "email.bounced", unsubscribe: "email.unsubscribed", group_unsubscribe: "email.unsubscribed" });
  });

  it("a tracked link click fires link.clicked for the contact", async () => {
    const app = express(); app.use("/api/r", smsRedirect);
    const token = jwt.sign({ sid: "s-1", u: "https://boreal.financial/apply" }, String(process.env.JWT_SECRET));
    const r = await request(app).get("/api/r/" + token);
    expect(r.status).toBe(302);
    await new Promise((res) => setTimeout(res, 10));
    expect(emitAutomationEvent).toHaveBeenCalledWith("link.clicked", { contactId: "c-1", data: { url: "https://boreal.financial/apply" } });
  });
});

describe("contact timeline", () => {
  it("shows automation steps and room recordings linked through call_recording_contacts", async () => {
    q.mockClear();
    await loadCrmTimeline(true, "c-1", "BF");
    const sql = String(q.mock.calls[0]![0]);
    expect(sql).toContain("'email_notice_sent','automation')");
    expect(sql).toContain("WHEN 'automation' THEN ('Automation: '");
    expect(sql).toContain("WHEN event_type = 'automation' THEN 'system'");
    expect(sql).toContain("EXISTS (SELECT 1 FROM call_recording_contacts rc WHERE rc.recording_id = cr.id AND rc.contact_id::text = $1::text)");
  });
  it("GET /api/crm/contacts/:id/calls includes recordings linked to the contact", () => {
    expect(src("src/routes/crm.ts")).toContain("OR cf.id IN (SELECT r2.conference_id FROM call_recording_contacts rc JOIN call_recordings r2 ON r2.id = rc.recording_id WHERE rc.contact_id::text = $1)");
  });
});
