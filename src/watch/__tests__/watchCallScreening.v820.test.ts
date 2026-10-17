// BF_SERVER_v820_WATCH_CALLS - the Watch callback bridge calls the staff cell first. The cell leg is screened so a
// callback that lands in the cell's voicemail never connects the client to it: only "1" bridges to the destination.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock };
});
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));
vi.mock("../../middleware/twilioWebhookValidation.js", () => ({ twilioWebhookValidation: (_req: any, _res: any, next: any) => next() }));

const CALL = "ffffffff-0000-4000-8000-0000000000c1";
const CONTACT = "c0c0c0c0-0000-4000-8000-000000000001";
const BRIDGE = /SELECT destination,contact_id FROM watch_call_bridges/;

async function app() {
  const router = (await import("../callRoutes.js")).default;
  const a = express();
  a.use("/api/telephony/watch", router);
  return a;
}
const twiml = async () => request(await app()).post(`/api/telephony/watch/provider/${CALL}/twiml`).type("form").send({ CallStatus: "in-progress" });
const accept = async (body: Record<string, string>) => request(await app()).post(`/api/telephony/watch/provider/${CALL}/accept`).type("form").send(body);

beforeEach(() => {
  queryMock.mockReset();
  process.env.PUBLIC_BASE_URL = "https://server.example.test";
});

describe("Watch callback cell-leg screening", () => {
  it("asks the staff member to press 1 and names the contact; nothing is bridged yet", async () => {
    queryMock.mockImplementation(answerBySql([
      [BRIDGE, { rows: [{ destination: "+15875550177", contact_id: CONTACT }] }],
      [/FROM contacts WHERE id::text=\$1/, { rows: [{ name: "Jane Client" }] }],
    ]));
    const res = await twiml();
    expect(res.status).toBe(200);
    expect(res.text).toContain('numDigits="1"');
    expect(res.text).toContain('timeout="8"');
    expect(res.text).toContain('actionOnEmptyResult="true"');
    expect(res.text).toContain(`action="https://server.example.test/api/telephony/watch/provider/${CALL}/accept"`);
    expect(res.text).toContain("Boreal call to Jane Client. Press 1 to connect.");
    expect(res.text).toContain("<Hangup/>");
    expect(res.text).not.toContain("<Dial");
    expect(callsMatching(queryMock, /SET status='bridging'/)).toHaveLength(0);
  });

  it("falls back to the destination's digits when there is no contact name", async () => {
    queryMock.mockImplementation(answerBySql([[BRIDGE, { rows: [{ destination: "+15875550177", contact_id: null }] }]]));
    const res = await twiml();
    expect(res.text).toContain("Boreal call to 5 8 7, 5 5 5, 0 1 7 7. Press 1 to connect.");
  });

  it("an ended bridge hangs up", async () => {
    queryMock.mockImplementation(answerBySql([]));
    const res = await twiml();
    expect(res.status).toBe(404);
    expect(res.text).toContain("<Hangup/>");
  });

  it("1 bridges to the destination loaded from the database", async () => {
    queryMock.mockImplementation(answerBySql([[/SELECT destination FROM watch_call_bridges/, { rows: [{ destination: "+15875550177" }] }]]));
    const res = await accept({ Digits: "1", To: "+15875550999" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Dial><Number>+15875550177</Number></Dial>");
    expect(callsMatching(queryMock, /SET status='bridging'/)[0]![1]).toEqual([CALL]);
  });

  it("anything else or silence (the cell's voicemail) hangs up and marks the bridge not accepted", async () => {
    for (const body of [{ Digits: "2" }, { Digits: "" }, {}] as Record<string, string>[]) {
      queryMock.mockReset();
      queryMock.mockImplementation(answerBySql([[/SELECT destination FROM watch_call_bridges/, { rows: [{ destination: "+15875550177" }] }]]));
      const res = await accept(body);
      expect(res.text).toContain("<Hangup/>");
      expect(res.text).not.toContain("<Dial");
      const [failed] = callsMatching(queryMock, /error_code='callback_not_accepted'/);
      expect(failed![1]).toEqual([CALL]);
    }
  });
});
