// BF_SERVER_v789_SG5 - drive every automation trigger emitter through the code that fires it.
// The calling test file mocks ../db.js (pool.query / pool.connect / runQuery / dbQuery all routed
// to one query mock), ../modules/automation/automationEngine.js and the external services listed in
// AUTOMATION_EMITTER_MOCKS below; each scenario here answers the SQL it needs and performs the
// request / call that should emit. The test then asserts on its emitAutomationEvent spy.
import crypto from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { answerBySql, type SqlRule } from "./answerBySql.js";
import { bearer } from "./staffToken.js";

type QueryMock = { mockReset: () => void; mockImplementation: (fn: (...a: any[]) => any) => unknown; mock: { calls: unknown[][] } };

export const IDS = {
  app: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  doc: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  contact: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  rule: "abababab-abab-4bab-8bab-abababababab",
};

function answer(q: QueryMock, rules: SqlRule[]): void {
  q.mockReset();
  q.mockImplementation(answerBySql(rules));
}

function appWith(path: string, router: express.Router, ...before: express.RequestHandler[]) {
  const app = express();
  app.use(express.json());
  app.use(path, ...before, router);
  return app;
}

export async function websiteContactForm(q: QueryMock) {
  answer(q, []);
  const { submitContactForm } = await import("../../modules/website/contact.controller.js");
  const app = express();
  app.use(express.json());
  app.post("/contact", submitContactForm);
  return request(app).post("/contact").send({ companyName: "Acme", fullName: "Ann Lee", phone: "+15875550100", email: "ann@acme.test" });
}

export async function clientBookingCreated(q: QueryMock) {
  const { albertaTime, createBooking } = await import("../../services/clientBooking.js");
  answer(q, [
    [/FROM users\s+WHERE COALESCE\(active, true\)/, { rows: [{ id: "u-todd", email: "todd@boreal.financial", first_name: "Todd", mailbox: "todd@boreal.financial", signed_in: true }] }],
    [/SELECT id::text, name, email, phone, owner_id::text FROM contacts/, { rows: [] }],
    [/INSERT INTO contacts/, { rows: [{ id: "ct-book" }] }],
  ]);
  const now = albertaTime(2026, 10, 12, 8, 0); // a Monday
  const startsAt = albertaTime(2026, 10, 12, 11, 0);
  // Outlook is not configured here, so the booking ends in a BookingCalendarError after the CRM records exist.
  await createBooking({ kind: "phone", startsAt, staffId: null, name: "Ann Lee", email: "ann@acme.test", phone: "5875550100", notes: null, now }).catch(() => undefined);
  return { startsAt };
}

async function crmApp() {
  const { default: crm } = await import("../../routes/crm.js");
  return appWith("/api/crm", crm);
}

export async function crmManualContact(q: QueryMock) {
  answer(q, []);
  return request(await crmApp()).post("/api/crm/contacts").set("Authorization", bearer("Admin")).send({ first_name: "Ann", last_name: "Lee", email: "ann@acme.test" });
}

export async function crmImport(q: QueryMock) {
  const cols = ["id", "first_name", "last_name", "name", "email", "phone", "company_name", "job_title", "lead_status", "silo", "owner_id", "updated_at"];
  answer(q, [
    [/FROM information_schema\.columns/, { rows: cols.map((column_name) => ({ column_name })) }],
    [/SELECT \* FROM contacts WHERE silo = \$1 AND lower\(email\) = lower\(\$2\)/, (_s: string, p?: unknown[]) =>
      String(p?.[1]) === "old@acme.test" ? { rows: [{ id: "ct-old", first_name: "Old", last_name: "Timer", phone: "5875550100", email: "old@acme.test" }] } : { rows: [] }],
    [/INSERT INTO contacts/, { rows: [{ id: "ct-new" }] }],
  ]);
  return request(await crmApp())
    .post("/api/crm/contacts/import")
    .set("Authorization", bearer("Admin"))
    .send({ rows: [{ email: "new@acme.test", first_name: "New", last_name: "Person" }, { email: "old@acme.test", first_name: "Old", last_name: "Timer", phone: "5875550199" }] });
}

export async function crmContactCalls(q: QueryMock) {
  answer(q, []);
  return request(await crmApp()).get(`/api/crm/contacts/${IDS.contact}/calls`).set("Authorization", bearer("Admin"));
}

const ROOM = { id: "room-1", title: "Kick-off", silo: "BF", contact_id: null, application_id: null, host_user_id: null };

export async function conferenceCallerJoins(q: QueryMock) {
  answer(q, [
    [/FROM meeting_rooms WHERE id::text = \$1/, { rows: [ROOM] }],
    [/SELECT id::text AS id FROM conferences WHERE meeting_room_id::text = \$1 AND ended_at IS NULL/, { rows: [{ id: "conf-1" }] }],
    [/INSERT INTO contacts/, { rows: [{ id: "ct-conf" }] }],
  ]);
  const { handleRoomStatus } = await import("../../services/meetingRoomConference.js");
  await handleRoomStatus({ roomId: ROOM.id, event: "participant-join", callSid: "CA1", conferenceSid: "CF1", from: "+15875550100" }, (sql, params) => (q as any)(sql, params));
  return ROOM;
}

export async function conferenceEnds(q: QueryMock) {
  answer(q, [
    [/FROM meeting_rooms WHERE id::text = \$1/, { rows: [ROOM] }],
    [/SELECT id::text AS id FROM conferences WHERE meeting_room_id::text = \$1 AND ended_at IS NULL/, { rows: [{ id: "conf-1" }] }],
    [/\) x WHERE x\.contact_id IS NOT NULL/, { rows: [{ contact_id: "ct-attendee" }] }],
  ]);
  const { handleRoomStatus } = await import("../../services/meetingRoomConference.js");
  await handleRoomStatus({ roomId: ROOM.id, event: "conference-end", callSid: null, conferenceSid: "CF1", from: null }, (sql, params) => (q as any)(sql, params));
  return ROOM;
}

const STAGE_EVENT_RULE: SqlRule = [/insert into application_stage_events/, { rows: [{ id: "stage-1" }] }];

export async function applicationCreated(q: QueryMock) {
  answer(q, [
    [/insert into applications/, { rows: [{ id: "app-new", pipeline_state: "Received" }] }],
    STAGE_EVENT_RULE,
  ]);
  const { createApplication } = await import("../../modules/applications/applications.repo.js");
  return createApplication({ ownerUserId: null, name: "Acme", metadata: {}, productType: "standard", source: "client" });
}

export async function applicationStageChanged(q: QueryMock) {
  answer(q, [
    [/from applications\s+where id = \$1/, { rows: [{ id: IDS.app, pipeline_state: "Received", owner_user_id: null, metadata: {} }] }],
    STAGE_EVENT_RULE,
  ]);
  const { transitionPipelineState } = await import("../../modules/applications/applications.service.js");
  await transitionPipelineState({ applicationId: IDS.app, nextState: "In Review" as any, actorUserId: null, actorRole: null, trigger: "test" });
}

export async function documentUploaded(q: QueryMock) {
  answer(q, []);
  const { persistAndEnqueue } = await import("../../routes/documents.js");
  await persistAndEnqueue({ applicationId: IDS.app, category: "bank_statements", file: { buffer: Buffer.from("%PDF-x"), originalname: "june.pdf", mimetype: "application/pdf" } as any });
}

export async function documentRejectedInDocuments(q: QueryMock) {
  answer(q, [[/SELECT application_id FROM documents WHERE id=\$1/, { rows: [{ application_id: IDS.app }] }]]);
  const { default: documents } = await import("../../routes/documents.js");
  return request(appWith("/api/documents", documents)).post(`/api/documents/${IDS.doc}/reject`).set("Authorization", bearer("Admin")).send({});
}

export async function documentRejectedInPortal(q: QueryMock) {
  answer(q, [
    [/UPDATE documents SET status = 'rejected', rejection_reason = \$2/, { rows: [{ id: IDS.doc, document_type: "Bank statements", application_id: IDS.app, status: "rejected" }] }],
    [/SELECT silo FROM applications WHERE id::text = \(\$1\)::text/, { rows: [{ silo: "BF" }] }],
  ]);
  const { default: portal } = await import("../../routes/portal.js");
  return request(appWith("/api/portal", portal)).post(`/api/portal/documents/${IDS.doc}/reject`).set("Authorization", bearer("Admin")).send({ reason: "blurry" });
}

export async function smsInbound(q: QueryMock) {
  answer(q, [
    [/WITH matched AS/, { rows: [{ id: "ct-sms" }] }],
    [/FROM communications_conversations/, { rows: [], rowCount: 0 }],
    [/INSERT INTO communications_conversations/, { rows: [{ id: "conv-1" }] }],
  ]);
  const { default: sms } = await import("../../routes/smsInboundWebhook.js");
  const app = express();
  app.use("/api", sms);
  return request(app).post("/api/webhooks/twilio/sms-inbound").type("form").send({ From: "+15875550100", To: "+18666318939", Body: "Hello there", MessageSid: "SM1" });
}

export async function clientPortalMessage(q: QueryMock) {
  answer(q, [
    [/WITH app_phones AS/, { rows: [{ total: 1, mine: 1, known: 1 }] }],
    [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [{ id: IDS.app }] }],
  ]);
  const { default: client } = await import("../../routes/client/index.js");
  const token = jwt.sign({ sub: "client:+15875550100", role: "client", isClient: true, phone: "+15875550100" }, String(process.env.JWT_SECRET));
  return request(appWith("/api/client", client)).post("/api/client/messages").set("Authorization", `Bearer ${token}`).send({ applicationId: IDS.app, body: "Any news?" });
}

export async function biApplicantMessage(q: QueryMock) {
  answer(q, []);
  process.env.BACKEND_SERVICE_TOKEN = "automation-emitters-token";
  const { default: bridge } = await import("../../routes/serviceBridge.js");
  return request(appWith("/api/service", bridge))
    .post("/api/service/applicant-messages")
    .set("x-backend-token", "automation-emitters-token")
    .set("x-applicant-phone", "+15875550100")
    .send({ body: "Question about my policy" });
}

export async function mailReply(q: QueryMock) {
  process.env.SENDGRID_REPLY_TO = "replies@boreal.test";
  answer(q, [
    [/FROM users WHERE lower\(email\) = \$1 AND o365_refresh_token IS NOT NULL/, { rows: [{ id: "u-mail" }] }],
    [/SELECT id, silo FROM contacts WHERE lower\(email\) = \$1/, { rows: [{ id: "ct-mail", silo: "BF" }] }],
    [/INSERT INTO communications_messages/, { rows: [], rowCount: 1 }],
  ]);
  const { startMailReplyWorker } = await import("../../workers/mailReplyWorker.js");
  return startMailReplyWorker({ query: (sql: string, params?: unknown[]) => (q as any)(sql, params) } as any);
}

export const MAIL_REPLY_GRAPH_MESSAGES = {
  value: [{ id: "g1", internetMessageId: "<m1@acme.test>", from: { emailAddress: { address: "Ann@Acme.test" } }, receivedDateTime: new Date().toISOString(), bodyPreview: "Thanks!" }],
};

export async function missedCall(q: QueryMock) {
  answer(q, [[/INSERT INTO call_events/, { rows: [{ id: "ce-1", occurred_at: new Date().toISOString() }] }]]);
  const { default: comms } = await import("../../routes/communications.js");
  return request(appWith("/api/communications", comms))
    .post("/api/communications/call-events")
    .set("Authorization", bearer("Admin"))
    .send({ event_type: "call.missed", to_number: "+15875550100", from_number: "+15875550199", contact_id: "ct-call" });
}

export async function trackedLinkClick(q: QueryMock) {
  answer(q, [[/SELECT contact_id FROM sms_campaign_sends/, { rows: [{ contact_id: "c-1" }] }]]);
  const { default: smsRedirect } = await import("../../routes/smsRedirect.js");
  const app = express();
  app.use("/api/r", smsRedirect);
  const token = jwt.sign({ sid: "s-1", u: "https://boreal.financial/apply" }, String(process.env.JWT_SECRET));
  return request(app).get("/api/r/" + token);
}

export async function sendgridEvent(q: QueryMock, event: Record<string, unknown>) {
  const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  answer(q, []);
  const { default: hook } = await import("../../routes/sendgridWebhook.js");
  const app = express();
  app.use("/webhook", hook);
  const body = JSON.stringify([event]);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createSign("sha256").update(ts + body).sign(keys.privateKey, "base64");
  return request(app)
    .post("/webhook")
    .set("Content-Type", "application/json")
    .set("X-Twilio-Email-Event-Webhook-Signature", signature)
    .set("X-Twilio-Email-Event-Webhook-Timestamp", ts)
    .send(body);
}

export async function automationWorkerTick(q: QueryMock) {
  answer(q, []);
  const { startAutomationWorker } = await import("../../workers/automationWorker.js");
  return startAutomationWorker({ query: (q as any) } as any, 3_600_000);
}

export async function manualEnroll(q: QueryMock) {
  answer(q, [[/FROM automation_rules WHERE id = \$1::uuid AND silo = \$2/, { rows: [{ id: IDS.rule, silo: "BF", graph: { nodes: [] }, settings: {}, goal: null }] }]]);
  const { default: automations } = await import("../../routes/automations.js");
  const { requireAuth } = await import("../../middleware/auth.js");
  return request(appWith("/api/automations", automations, requireAuth))
    .post(`/api/automations/${IDS.rule}/enroll`)
    .set("Authorization", bearer("Staff"))
    .send({ contactId: IDS.contact });
}
