// BF_SERVER_v973_TEAM_LINE_NO_NAMES - a caller to the Boreal Risk Management line is never told a staff member's name.
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import twilio from "twilio";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));

const TARGET_SQL = /FROM users u JOIN staff_presence sp ON sp\.user_id = u\.id\s+WHERE \(u\.first_name ILIKE \$1/;
const BASE = "/api/webhooks/twilio/reception";
const staff = (row: Record<string, unknown>) => ({ status: "available", twilio_identity: "staff-client", on_call: false, fresh: true, phone: null, standalone_watch: false, user_id: "11111111-1111-4111-8111-111111111111", ...row });

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
const spoken = (xml: string) => [...xml.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)].map((m) => m[1]).join(" ");

beforeEach(() => { h.query.mockReset(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-18T18:00:00Z")); });

describe("the Boreal Risk Management line", () => {
  it("asks the caller to stay on the line for the next team member, and rings the person without naming them", async () => {
    h.query.mockImplementation(answerBySql([[TARGET_SQL, { rows: [staff({})] }]]));
    const xml = await post("/line?silo=BI", { From: "+15875550142", CallSid: "CA1" });
    const said = spoken(xml);
    expect(said).toContain("Thank you for calling Boreal Risk Management.");
    expect(said).toContain("Please stay on the line for the next team member who can assist you.");
    expect(said).not.toMatch(/connecting you to/i);
    expect(xml).toMatch(/<Client[^>]*>staff-client<\/Client>/);
    expect(xml).toContain("tl=1"); // the follow-up steps keep the no-name rule
  });

  it("says no one is available, without a name, when the person cannot be reached or does not pick up", async () => {
    h.query.mockImplementation(answerBySql([[TARGET_SQL, { rows: [staff({ twilio_identity: null, fresh: false })] }]]));
    const said = spoken(await post("/line?silo=BI", { From: "+15875550142", CallSid: "CA2" }));
    expect(said).toContain("Sorry, no one is available to take your call right now.");
    expect(said).not.toMatch(/isn't available right now|is on another call/);
  });
});
