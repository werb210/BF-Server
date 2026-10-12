// BF_SERVER_TEST_SEND_REAL_CONTACT_v26 - a test send merges the matching CRM contact
// in the active silo, not a hardcoded placeholder.
import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, sendOne, sendMarketingSms } = vi.hoisted(() => ({ queryMock: vi.fn(), sendOne: vi.fn(), sendMarketingSms: vi.fn() }));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../services/sendgridService.js", async (orig) => {
  const real: any = await orig();
  return { ...real, sendgridConfigured: () => true, sendOne };
});
vi.mock("../services/marketingSms.js", async (orig) => {
  const real: any = await orig();
  return { ...real, smsMarketingConfigured: () => true, sendMarketingSms };
});

import marketing from "../routes/marketing.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const post = (url: string, body: Record<string, unknown>, silo = "BF") =>
  request(app).post(url).set("Authorization", `Bearer ${token}`).set("X-Silo", silo).send(body);

const JANE = { name: "Jane Doe", first_name: null, last_name: null, email: "jane@acme.test", company: "Acme Ltd" };
const EMAIL_LOOKUP = /lower\(c\.email\) = lower\(\$2\)/;
const SMS_LOOKUP = /right\(regexp_replace\(COALESCE\(c\.phone,''\), '\[\^0-9\]', '', 'g'\), 10\) = right\(\$2, 10\)/;

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [EMAIL_LOOKUP, (_s: string, p?: unknown[]) => (p?.[0] === "BF" && String(p?.[1]).toLowerCase() === "jane@acme.test" ? { rows: [JANE] } : { rows: [] })],
    [SMS_LOOKUP, (_s: string, p?: unknown[]) => (p?.[0] === "BF" && String(p?.[1]).endsWith("4035550101") ? { rows: [JANE] } : { rows: [] })],
  ]));
  sendOne.mockReset();
  sendOne.mockResolvedValue({ ok: true, status: 202 });
  sendMarketingSms.mockReset();
  sendMarketingSms.mockResolvedValue({ ok: true, sid: "SM1" });
});

describe("test sends use the real contact", () => {
  it("a raw email test merges the matching contact", async () => {
    const r = await post("/api/marketing/email/send", { subject: "Hi {{first_name}}", html: "<p>{{name}} at {{company}}</p>", test: "Jane@Acme.test" });
    expect(r.body.data.test).toBe(true);
    expect(sendOne).toHaveBeenCalledWith({ to: "Jane@Acme.test", subject: "Hi Jane", html: "<p>Jane Doe at Acme Ltd</p>" });
  });

  it("a branded email test merges the matching contact", async () => {
    await post("/api/marketing/email/send-template", { subject: "Hi {{first_name}}", headline: "Hello {{name}}", test: "jane@acme.test" });
    expect(sendOne.mock.calls[0][0].subject).toBe("Hi Jane");
    expect(sendOne.mock.calls[0][0].html).toContain("Hello Jane Doe");
  });

  it("an SMS test merges the matching contact, matched on the last 10 digits", async () => {
    const r = await post("/api/marketing/sms/send", { body: "Hi {{first_name}}", test: "+1 (403) 555-0101" });
    expect(r.body.data.test).toBe(true);
    expect(sendMarketingSms.mock.calls[0][0]).toBe("+1 (403) 555-0101");
    expect(String(sendMarketingSms.mock.calls[0][1])).toMatch(/^Hi Jane /);
    const lookup = callsMatching(queryMock, SMS_LOOKUP)[0][1] as unknown[];
    expect(lookup).toEqual(["BF", "14035550101"]);
  });

  it("scopes the lookup to the active silo", async () => {
    await post("/api/marketing/email/send", { subject: "Hi {{first_name}}", html: "<p>x</p>", test: "jane@acme.test" }, "BI");
    expect((callsMatching(queryMock, EMAIL_LOOKUP)[0][1] as unknown[])[0]).toBe("BI");
    // Jane lives in BF, so a BI test does not see her.
    expect(sendOne.mock.calls[0][0].subject).toBe("Hi there");
  });

  it("still falls back to the placeholder when nothing matches", async () => {
    await post("/api/marketing/email/send", { subject: "Hi {{first_name}}", html: "<p>{{name}} {{email}}</p>", test: "nobody@x.test" });
    expect(sendOne).toHaveBeenCalledWith({ to: "nobody@x.test", subject: "Hi there", html: "<p>there nobody@x.test</p>" });
  });

  it("falls back when the lookup itself fails", async () => {
    queryMock.mockImplementation(answerBySql([[EMAIL_LOOKUP, new Error("db down")]]));
    await post("/api/marketing/email/send", { subject: "Hi {{first_name}}", html: "<p>x</p>", test: "jane@acme.test" });
    expect(sendOne.mock.calls[0][0].subject).toBe("Hi there");
  });
});
