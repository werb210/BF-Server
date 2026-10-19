// BF_SERVER_v820_WATCH_CALLS - a call to a staff member's direct number: the app rings first; with the standalone
// Watch fallback on it rings for 15 s and the action callback (cell=1) then tries the verified cell, screened.
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { mountRouter } from "../../__tests__/helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: h.query }, dbQuery: h.query, runQuery: h.query }));
vi.mock("../../middleware/twilioWebhookValidation.js", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { twilioWebhookValidation: pass, validateTwilioWebhook: pass };
});
vi.mock("../../modules/calls/calls.service.js", async () => ({
  ...(await vi.importActual<any>("../../modules/calls/calls.service.js")),
  startCall: async () => ({ id: "call-1" }),
}));

const OWNER = "44444444-4444-4444-8444-444444444444";
const DIRECT_SQL = /WHERE u\.direct_number = \$1/;
const WATCH_CELL_SQL = /WHERE u\.id::text = \$1\s+AND u\.callback_verified_at IS NOT NULL/;

async function callDirectLine(watchCell: string | null): Promise<string> {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    [DIRECT_SQL, { rows: [{ user_id: OWNER, first_name: "Pat", last_name: "Staff", twilio_identity: OWNER }] }],
    [WATCH_CELL_SQL, { rows: watchCell ? [{ phone: watchCell }] : [] }],
  ]));
  const app = mountRouter((await import("../webhooks.js")).default, "/api/webhooks");
  const res = await request(app).post("/api/webhooks/twilio/voice/twiml").type("form")
    .send({ From: "+15875550142", To: "+18255550190", CallSid: "CA-direct-1" });
  expect(res.status).toBe(200);
  return res.text;
}

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });

describe("direct line routing with the standalone Watch fallback", () => {
  it("rings the owner's app for 15 s and hands the cell to direct-unavailable?cell=1", async () => {
    const xml = await callDirectLine("4035550103");
    expect(xml).toMatch(new RegExp(`<Client[^>]*>${OWNER}</Client>`));
    expect(xml).toContain('timeout="22"') // BF_SERVER_v829_DIALER_RELIABILITY - was 15;
    expect(xml).toContain(`/api/webhooks/twilio/reception/direct-unavailable?user=${OWNER}&amp;cell=1`);
    expect(xml).not.toContain("<Number"); // never parallel with the app
    expect(callsMatching(h.query, WATCH_CELL_SQL)[0]![1]).toEqual([OWNER]);
  });

  it("keeps the 25 s app-only ring without the fallback", async () => {
    const xml = await callDirectLine(null);
    expect(xml).toMatch(new RegExp(`<Client[^>]*>${OWNER}</Client>`));
    expect(xml).toContain('timeout="25"');
    expect(xml).not.toContain("cell=1");
  });
});
