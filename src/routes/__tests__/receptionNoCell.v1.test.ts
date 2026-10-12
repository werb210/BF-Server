import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import twilio from "twilio";
import { answerBySql, callsMatching, sqlText } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));

const ANDREW = "22222222-2222-4222-8222-222222222222";
const TARGET_SQL = /FROM users u JOIN staff_presence sp ON sp\.user_id = u\.id\s+WHERE \(u\.first_name ILIKE \$1/;

// Andrew (the credit line, keypad 2) as reception's resolveTarget sees him.
function andrew(row: Record<string, unknown>) {
  h.query.mockImplementation(answerBySql([
    [TARGET_SQL, { rows: [{ status: "available", twilio_identity: "andrew-client", on_call: false, fresh: true, phone: null, standalone_watch: false, user_id: ANDREW, ...row }] }],
  ]));
}

async function askForCredit() {
  const router = (await import("../reception.js")).default;
  const app = express();
  app.use("/api/webhooks/twilio/reception", router);
  const full = "/api/webhooks/twilio/reception/intent?company=BF";
  const params = { Digits: "2", From: "+15875550142" };
  const res = await request(app).post(full).type("form").set("X-Forwarded-Host", "example.com").set("X-Forwarded-Proto", "https")
    .set("X-Twilio-Signature", twilio.getExpectedTwilioSignature(String(process.env.TWILIO_AUTH_TOKEN), "https://example.com" + full, params))
    .send(params);
  expect(res.status).toBe(200);
  return res.text;
}

beforeEach(() => { h.query.mockReset(); });

describe("reception routing precedence", () => {
  it("prefers the Boreal client when it is ready, even with a verified Watch cell on file", async () => {
    andrew({ phone: "403-555-0100", standalone_watch: true });
    const xml = await askForCredit();
    expect(xml).toContain("<Client>andrew-client</Client>");
    expect(xml).not.toContain("<Number>");
  });

  it("permits the gated standalone Watch cellular fallback only when the client is not reachable", async () => {
    andrew({ status: "offline", fresh: false, phone: "403-555-0100", standalone_watch: true });
    const xml = await askForCredit();
    expect(xml).toContain("<Number>+14035550100</Number>");
    expect(xml).not.toContain("<Client>");
  });

  it("a cell on file without the Watch opt-in is never dialled", async () => {
    andrew({ status: "offline", fresh: false, phone: "403-555-0100", standalone_watch: false });
    const xml = await askForCredit();
    expect(xml).not.toContain("<Number>");
    expect(xml).not.toContain("<Dial");
    expect(xml).toContain("<Record");
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
