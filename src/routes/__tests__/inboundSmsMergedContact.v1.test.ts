// BF_SERVER_INBOUND_SMS_MERGED_CONTACT_v1
// Both inbound SMS paths are driven through their routes with the database faked by
// SQL content: the resolution statement they send is checked for the properties that
// regressed in production, and the contact it returns is the one the message is stamped with.
import { readFileSync } from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { mountRouter } from "../../__tests__/helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: h.query }, dbQuery: h.query }));
vi.mock("../../middleware/twilioWebhookValidation.js", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { twilioWebhookValidation: pass, validateTwilioWebhook: pass };
});
vi.mock("../../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: async () => undefined }));
vi.mock("../../services/biOutreach.js", async () => ({
  ...(await vi.importActual<any>("../../services/biOutreach.js")),
  bumpBiOutreachToEngagedByPhone: async () => undefined,
}));
vi.mock("../../modules/automation/automationEngine.js", async () => ({
  ...(await vi.importActual<any>("../../modules/automation/automationEngine.js")),
  emitAutomationEvent: async () => undefined,
}));

const migration = readFileSync(path.join(process.cwd(), "migrations/2026_07_22_repoint_merged_contact_activity.sql"), "utf8");
const SURVIVOR = "5a5a5a5a-0000-4000-8000-000000000001";

async function viaWebhooks(): Promise<string> {
  h.query.mockImplementation(answerBySql([[/WITH matched AS/, { rows: [{ id: SURVIVOR, silo: "BF", name: "Live Survivor", primary_match: false }] }]]));
  const app = mountRouter((await import("../webhooks.js")).default, "/api/webhooks");
  const res = await request(app).post("/api/webhooks/twilio/sms").type("form").send({ From: "+14035550111", To: "+18666318939", Body: "hello", MessageSid: "SM-merged-1" });
  expect(res.status).toBe(200);
  const [insert] = callsMatching(h.query, /INSERT INTO communications_messages/);
  expect((insert[1] as unknown[])[0]).toBe(SURVIVOR);
  return String(callsMatching(h.query, /WITH matched AS/)[0][0]);
}

async function viaSmsInbound(): Promise<string> {
  h.query.mockImplementation(answerBySql([
    [/FROM communications_conversations/, { rowCount: 1, rows: [{ id: "conv-1" }] }],
    [/WITH matched AS/, { rows: [{ id: SURVIVOR }] }],
  ]));
  const app = mountRouter((await import("../smsInboundWebhook.js")).default, "/api");
  await request(app).post("/api/webhooks/twilio/sms-inbound").type("form").send({ From: "+14035550111", To: "+18666318939", Body: "hello", MessageSid: "SM-merged-2" });
  const [insert] = callsMatching(h.query, /INSERT INTO communications_messages/);
  expect((insert[1] as unknown[])[1]).toBe(SURVIVOR);
  return String(callsMatching(h.query, /WITH matched AS/)[0][0]);
}

beforeEach(() => {
  h.query.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("inbound sms never resolves to a merged-away contact", () => {
  it("webhooks.ts excludes archived contacts", async () => {
    expect(await viaWebhooks()).toContain("WHERE coalesce(status, '') <> 'archived'");
  });

  it("webhooks.ts follows merged_into_id to the live survivor", async () => {
    const sql = await viaWebhooks();
    expect(sql).toContain("ON surv.id = m.merged_into_id");
    expect(sql).toContain("AND surv.merged_into_id IS NULL");
  });

  it("webhooks.ts no longer breaks ties toward the oldest row", async () => {
    const sql = await viaWebhooks();
    expect(sql).not.toContain("ORDER BY primary_match DESC, created_at ASC NULLS LAST, id ASC");
    expect(sql).toContain("primary_match DESC, updated_at DESC NULLS LAST");
  });

  it("smsInboundWebhook.ts excludes archived contacts and follows the merge pointer", async () => {
    const sql = await viaSmsInbound();
    expect(sql).toContain("ON surv.id = m.merged_into_id");
    expect(sql).toContain("WHERE coalesce(status, '') <> 'archived'");
    expect(sql).not.toMatch(/ORDER BY created_at ASC\s+LIMIT 1/);
  });

  it("smsInboundWebhook.ts also matches on secondary_phone", async () => {
    // A merge copies the loser's number onto the survivor's secondary_phone, so a
    // primary-phone-only match could miss the survivor entirely.
    expect(await viaSmsInbound()).toContain("secondary_phone IS NOT NULL");
  });

  it("the repair migration walks merge chains and is idempotent", () => {
    expect(migration).toContain("WITH RECURSIVE chain(loser_id, survivor_id)");
    expect(migration).toContain("UPDATE communications_messages m");
    expect(migration).toContain("UPDATE call_logs cl");
    expect(migration).toContain("AND coalesce(s.status, '') <> 'archived'");
  });
});
