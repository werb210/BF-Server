// BF_SERVER_TEST_SEND_NAME_COLUMN_v29 + BF_SERVER_CI_GREEN_AND_NAME_PRECEDENCE_v30
// A test send merges the same name a live send would: contacts.name first, then
// first_name/last_name, then the literal "there".
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const { queryMock, sendOne, sendMarketingSms, contact } = vi.hoisted(() => ({
  queryMock: vi.fn(), sendOne: vi.fn(), sendMarketingSms: vi.fn(),
  contact: { row: null as Record<string, unknown> | null },
}));

vi.mock("../../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../../services/sendgridService.js", async (orig) => {
  const real: any = await orig();
  return { ...real, sendgridConfigured: () => true, sendOne };
});
vi.mock("../../services/marketingSms.js", async (orig) => {
  const real: any = await orig();
  return { ...real, smsMarketingConfigured: () => true, sendMarketingSms };
});

import marketing from "../marketing.js";
import { runEmailSend } from "../../services/marketingSendRunner.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const LOOKUP = /SELECT c\.name, c\.first_name, c\.last_name, c\.email, co\.name AS company\s+FROM contacts c/;

async function emailTest(row: Record<string, unknown> | null, silo = "BF") {
  contact.row = row;
  sendOne.mockClear();
  await request(app).post("/api/marketing/email/send").set("Authorization", `Bearer ${token}`).set("X-Silo", silo)
    .send({ subject: "{{first_name}}|{{name}}", html: "<p>x</p>", test: "t@x.test" });
  return String(sendOne.mock.calls[0][0].subject);
}

beforeEach(() => {
  contact.row = null;
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([[LOOKUP, () => ({ rows: contact.row ? [contact.row] : [] })]]));
  sendOne.mockReset();
  sendOne.mockResolvedValue({ ok: true, status: 202 });
  sendMarketingSms.mockReset();
  sendMarketingSms.mockResolvedValue({ ok: true, sid: "SM1" });
});

describe("testSendVars", () => {
  it("both lookups select contacts.name, the column the CRM shows and the blast merges from", async () => {
    await emailTest(null);
    await request(app).post("/api/marketing/sms/send").set("Authorization", `Bearer ${token}`).send({ body: "x", test: "+14035550101" });
    const lookups = callsMatching(queryMock, LOOKUP);
    expect(lookups).toHaveLength(2);
  });

  it("prefers name and falls back to first_name and last_name when it is blank", async () => {
    expect(await emailTest({ name: "  ", first_name: "Ann", last_name: "Lee", email: "t@x.test", company: null })).toBe("Ann|Ann Lee");
    expect(await emailTest({ name: null, first_name: "Ann", last_name: null, email: "t@x.test", company: null })).toBe("Ann|Ann");
  });

  it("still falls back to the literal when nothing matches at all", async () => {
    expect(await emailTest(null)).toBe("there|there");
    expect(await emailTest({ name: "", first_name: null, last_name: null, email: "t@x.test", company: null })).toBe("there|there");
  });

  it("keeps the silo filter on both lookups", async () => {
    await emailTest(null, "BI");
    await request(app).post("/api/marketing/sms/send").set("Authorization", `Bearer ${token}`).set("X-Silo", "BI").send({ body: "x", test: "+14035550101" });
    for (const [sql, params] of callsMatching(queryMock, LOOKUP)) {
      expect(String(sql)).toContain("WHERE c.silo = $1");
      expect((params as unknown[])[0]).toBe("BI");
    }
  });
});

describe("name precedence", () => {
  it("prefers contacts.name outright, matching the live send", async () => {
    expect(await emailTest({ name: "Jane Doe", first_name: "Janet", last_name: "Smith", email: "t@x.test", company: null })).toBe("Jane|Jane Doe");
  });

  it("still derives first_name from the resolved full name", async () => {
    expect(await emailTest({ name: "  Mary   Ann Smith ", first_name: null, last_name: null, email: "t@x.test", company: null })).toBe("Mary|Mary   Ann Smith");
  });
});

describe("parity with the live send path", () => {
  it("marketingSendRunner merges first_name from c.name, falling back to there", async () => {
    const pool = {
      query: vi.fn(answerBySql([[/FROM contacts c LEFT JOIN companies co/, {
        rows: [
          { id: "c1", email: "a@x.test", name: "Jane Doe", company: null },
          { id: "c2", email: "b@x.test", name: null, company: null },
        ],
      }]])),
    };
    await runEmailSend(pool as any, { silo: "BF", tag: "vip", subject: "{{first_name}}|{{name}}", html: "<p>x</p>" });
    expect(sendOne.mock.calls.map((c) => c[0].subject)).toEqual(["Jane|Jane Doe", "there|there"]);
  });
});
