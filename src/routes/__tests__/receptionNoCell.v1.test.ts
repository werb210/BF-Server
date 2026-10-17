import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import twilio from "twilio";
import { answerBySql, callsMatching, sqlText, type SqlRule } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));

const ANDREW = "22222222-2222-4222-8222-222222222222";
const TODD = "11111111-1111-4111-8111-111111111111";
const DIRECT_OWNER = "33333333-3333-4333-8333-333333333333";
const CALLER = "+15875550142";
const TARGET_SQL = /FROM users u JOIN staff_presence sp ON sp\.user_id = u\.id\s+WHERE \(u\.first_name ILIKE \$1/;
const WATCH_CELL_SQL = /WHERE u\.id::text = \$1\s+AND u\.callback_verified_at IS NOT NULL/;
const NAMED_RECIPIENTS = /AND id::text = ANY\(\$1::text\[\]\)/;
const BASE = "/api/webhooks/twilio/reception";

function staffRow(row: Record<string, unknown>) {
  return { status: "available", twilio_identity: "andrew-client", on_call: false, fresh: true, phone: null, standalone_watch: false, user_id: ANDREW, ...row };
}

// Andrew (the credit line, keypad 2) as reception's resolveTarget sees him.
function andrew(row: Record<string, unknown>, extra: SqlRule[] = []) {
  h.query.mockImplementation(answerBySql([...extra, [TARGET_SQL, { rows: [staffRow(row)] }]]));
}

async function post(pathAndQuery: string, params: Record<string, string>) {
  const router = (await import("../reception.js")).default;
  const app = express();
  app.use(BASE, router);
  const full = `${BASE}${pathAndQuery}`;
  const res = await request(app).post(full).type("form").set("X-Forwarded-Host", "example.com").set("X-Forwarded-Proto", "https")
    .set("X-Twilio-Signature", twilio.getExpectedTwilioSignature(String(process.env.TWILIO_AUTH_TOKEN), "https://example.com" + full, params))
    .send(params);
  expect(res.status).toBe(200);
  return res.text;
}

const askForCredit = () => post("/intent?company=BF", { Digits: "2", From: CALLER });

beforeEach(() => { h.query.mockReset(); });

describe("reception routing precedence", () => {
  it("rings only the Boreal client (25 s) for staff without the Watch fallback, even with a cell on file", async () => {
    andrew({ phone: "403-555-0100", standalone_watch: false });
    const xml = await askForCredit();
    expect(xml).toContain("<Client>andrew-client</Client>");
    expect(xml).toContain('timeout="25"');
    expect(xml).not.toContain("<Number");
    expect(xml).not.toContain("cell=1");
  });

  // BF_SERVER_v820_WATCH_CALLS - app first (15 s), then the cell: sequential, never in the same <Dial>.
  it("with the Watch fallback on, rings the ready client first for 15 s and hands the cell to the action callback", async () => {
    andrew({ phone: "403-555-0100", standalone_watch: true });
    const xml = await askForCredit();
    expect(xml).toContain("<Client>andrew-client</Client>");
    expect(xml).toContain('timeout="15"');
    expect(xml).toContain(`action="${BASE}/unavailable?target=underwriting&amp;cell=1"`);
    expect(xml).not.toContain("<Number");
  });

  it("an unanswered client leg then rings the verified cell with the press-1 screen", async () => {
    andrew({ phone: "403-555-0100", standalone_watch: true });
    const xml = await post("/unavailable?target=underwriting&cell=1", { DialCallStatus: "no-answer", CallStatus: "in-progress", From: CALLER });
    expect(xml).toContain(`<Number url="${BASE}/screen?from=%2B15875550142" method="POST">+14035550100</Number>`);
    expect(xml).toContain(`action="${BASE}/unavailable?target=underwriting"`); // no second cell hop
    expect(xml).not.toContain("<Client>");
    expect(xml).not.toContain("<Record");
  });

  it("a busy or failed client leg also falls through to the cell", async () => {
    for (const status of ["busy", "failed"]) {
      andrew({ phone: "403-555-0100", standalone_watch: true });
      const xml = await post("/unavailable?target=underwriting&cell=1", { DialCallStatus: status, From: CALLER });
      expect(xml).toContain("+14035550100</Number>");
    }
  });

  it("an answered client leg never rings the cell", async () => {
    andrew({ phone: "403-555-0100", standalone_watch: true });
    const xml = await post("/unavailable?target=underwriting&cell=1", { DialCallStatus: "completed", From: CALLER });
    expect(xml).toContain("<Hangup/>");
    expect(xml).not.toContain("<Number");
  });

  it("a caller who already hung up is not dialled onward", async () => {
    andrew({ phone: "403-555-0100", standalone_watch: true });
    const xml = await post("/unavailable?target=underwriting&cell=1", { DialCallStatus: "no-answer", CallStatus: "completed", From: CALLER });
    expect(xml).not.toContain("<Number");
  });

  it("an unanswered cell leg goes to the person's voicemail and alerts them of the missed call", async () => {
    andrew({ phone: "403-555-0100", standalone_watch: true });
    const xml = await post("/unavailable?target=underwriting", { DialCallStatus: "no-answer", From: CALLER, CallSid: "CA-missed-1" });
    expect(xml).toContain("<Record");
    expect(xml).toContain(`staff=${ANDREW}`);
    expect(xml).not.toContain("<Number");
    await vi.waitFor(() => expect(callsMatching(h.query, NAMED_RECIPIENTS)).toHaveLength(1));
    expect(callsMatching(h.query, NAMED_RECIPIENTS)[0]![1]).toEqual([[ANDREW]]);
  });

  it("rings the screened cell directly when the client is not reachable", async () => {
    andrew({ status: "offline", fresh: false, phone: "403-555-0100", standalone_watch: true });
    const xml = await askForCredit();
    expect(xml).toContain(`<Number url="${BASE}/screen?from=%2B15875550142" method="POST">+14035550100</Number>`);
    expect(xml).not.toContain("<Client>");
  });

  it("a cell on file without the Watch opt-in is never dialled", async () => {
    andrew({ status: "offline", fresh: false, phone: "403-555-0100", standalone_watch: false });
    const xml = await askForCredit();
    expect(xml).not.toContain("<Number>");
    expect(xml).not.toContain("<Dial");
    expect(xml).toContain("<Record");
    await vi.waitFor(() => expect(callsMatching(h.query, NAMED_RECIPIENTS)).toHaveLength(1));
  });

  it("the Watch fallback reads only a server-verified callback number and an enabled Watch", async () => {
    andrew({});
    await askForCredit();
    const [sql] = callsMatching(h.query, TARGET_SQL)[0]!;
    expect(sqlText(sql)).toContain("u.verified_callback_number AS phone");
    expect(sqlText(sql)).toContain("callback_verified_at IS NOT NULL");
    expect(sqlText(sql)).toContain("standalone_routing_enabled=true");
  });
});

describe("client engagement group with Todd's Watch fallback", () => {
  function engagement(toddWatch: boolean) {
    h.query.mockImplementation(answerBySql([
      [TARGET_SQL, (_sql: string, params?: unknown[]) => ({ rows: [String(params?.[0]).includes("todd")
        ? staffRow({ twilio_identity: "todd-client", user_id: TODD, phone: "403-555-0101", standalone_watch: toddWatch })
        : staffRow({})] })],
      [/SELECT DISTINCT sp\.twilio_identity/, { rows: [{ twilio_identity: "staff-2" }] }],
    ]));
  }

  it("rings the apps for 15 s, then Todd's screened cell", async () => {
    engagement(true);
    const first = await post("/intent?company=BF", { Digits: "1", From: CALLER });
    expect(first).toContain("<Client>todd-client</Client>");
    expect(first).toContain("<Client>staff-2</Client>");
    expect(first).toContain('timeout="15"');
    expect(first).toContain("target=engagement&amp;cell=1");
    expect(first).not.toContain("<Number");

    const second = await post("/unavailable?target=engagement&cell=1", { DialCallStatus: "no-answer", From: CALLER });
    expect(second).toContain("+14035550101</Number>");
    expect(second).toContain("/screen?from=");
    expect(second).not.toContain("<Client>");
  });

  it("keeps the 25 s group ring without the fallback", async () => {
    engagement(false);
    const xml = await post("/intent?company=BF", { Digits: "1", From: CALLER });
    expect(xml).toContain('timeout="25"');
    expect(xml).not.toContain("cell=1");
    const after = await post("/unavailable?target=engagement", { DialCallStatus: "no-answer", From: CALLER });
    expect(after).toContain("<Record");
    expect(after).not.toContain("<Number");
  });
});

describe("cell-leg call screening", () => {
  it("names the CRM contact and waits 8 s for a single key, then hangs up", async () => {
    h.query.mockImplementation(answerBySql([[/FROM contacts/, { rows: [{ id: "c-1", name: "Jane Client" }] }]]));
    const xml = await post("/screen?from=%2B15875550142", { From: CALLER, ParentCallSid: "CA-parent" });
    expect(xml).toMatch(/<Gather input="dtmf" numDigits="1" timeout="8" action="\/api\/webhooks\/twilio\/reception\/screen-result" method="POST"><Say voice="Polly.Joanna">Boreal call from Jane Client\. Press 1 to accept\.<\/Say><\/Gather><Hangup\/>/);
    const [, params] = callsMatching(h.query, /FROM contacts/)[0]!;
    expect(params).toEqual(["5875550142"]);
  });

  it("reads an unknown caller's number digit by digit", async () => {
    h.query.mockImplementation(answerBySql([]));
    const xml = await post("/screen?from=%2B15875550142", {});
    expect(xml).toContain("Boreal call from 5 8 7, 5 5 5, 0 1 4 2. Press 1 to accept.");
  });

  it("connects only on 1; any other key or silence hangs up the cell leg", async () => {
    const yes = await post("/screen-result", { Digits: "1" });
    expect(yes).toContain("Connecting.");
    expect(yes).not.toContain("<Hangup");
    for (const params of [{ Digits: "2" }, { Digits: "" }, {}] as Record<string, string>[]) {
      expect(await post("/screen-result", params)).toContain("<Hangup/>");
    }
  });
});

describe("direct line with the Watch fallback", () => {
  it("an unanswered app leg rings the owner's verified cell, screened, once", async () => {
    h.query.mockImplementation(answerBySql([[WATCH_CELL_SQL, { rows: [{ phone: "(403) 555-0102" }] }]]));
    const xml = await post(`/direct-unavailable?user=${DIRECT_OWNER}&cell=1`, { DialCallStatus: "no-answer", From: CALLER });
    expect(xml).toContain(`<Number url="${BASE}/screen?from=%2B15875550142" method="POST">+14035550102</Number>`);
    expect(xml).toContain(`action="${BASE}/direct-unavailable?user=${DIRECT_OWNER}"`);
    expect(callsMatching(h.query, WATCH_CELL_SQL)[0]![1]).toEqual([DIRECT_OWNER]);
  });

  it("without the fallback the owner's voicemail answers and they get a missed-call alert", async () => {
    h.query.mockImplementation(answerBySql([[/SELECT first_name FROM users/, { rows: [{ first_name: "Pat" }] }]]));
    const xml = await post(`/direct-unavailable?user=${DIRECT_OWNER}&cell=1`, { DialCallStatus: "no-answer", From: CALLER });
    expect(xml).toContain("Sorry, Pat isn't available right now.");
    expect(xml).toContain("<Record");
    expect(xml).not.toContain("<Number");
    await vi.waitFor(() => expect(callsMatching(h.query, NAMED_RECIPIENTS)).toHaveLength(1));
    expect(callsMatching(h.query, NAMED_RECIPIENTS)[0]![1]).toEqual([[DIRECT_OWNER]]);
  });

  it("an answered direct line does nothing more", async () => {
    h.query.mockImplementation(answerBySql([[WATCH_CELL_SQL, { rows: [{ phone: "4035550102" }] }]]));
    const xml = await post(`/direct-unavailable?user=${DIRECT_OWNER}&cell=1`, { DialCallStatus: "completed", From: CALLER });
    expect(xml).not.toContain("<Number");
    expect(xml).not.toContain("<Record");
  });
});
