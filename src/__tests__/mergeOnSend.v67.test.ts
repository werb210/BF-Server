// BF_SERVER_MERGE_ON_SEND_v67 - renderMergeFields shipped in v65 and nothing
// called it, so {{contact.first_name}} went to clients as literal text.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasMergeFields, renderMergeFields } from "../services/mergeFields.js";
import { answerBySql, callsMatching, type SqlRule } from "./helpers/answerBySql.js";

const { queryMock, createMock } = vi.hoisted(() => ({ queryMock: vi.fn(), createMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock };
});
vi.mock("../lib/sharedClients.js", () => ({
  sharedTwilio: () => ({ messages: { create: createMock } }),
  sharedOpenAI: () => ({}),
}));

const STAFF_ID = "00000000-0000-4000-8000-0000000000a1";
const CONTACT = "11111111-2222-4333-8444-555555555555";
const TO = "+15874441234";
const token = () => jwt.sign({ sub: STAFF_ID, id: STAFF_ID, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));

async function app() {
  const router = (await import("../routes/communications.js")).default;
  const a = express();
  a.use(express.json());
  a.use("/api/communications", router);
  return a;
}
const sendSms = async (body: Record<string, unknown>) =>
  request(await app()).post("/api/communications/sms").set("Authorization", `Bearer ${token()}`).send(body);

function db(extra: SqlRule[] = []) {
  queryMock.mockImplementation(answerBySql([
    ...extra,
    [/FROM contacts c\s+LEFT JOIN companies co/, { rows: [{ name: "Jordan Lee", first_name: null, email: "j@lee.test", phone: TO, company_name: "Lee Haulage" }] }],
  ]));
}

beforeEach(() => {
  queryMock.mockReset();
  createMock.mockReset();
  createMock.mockResolvedValue({ sid: "SM1", status: "queued" });
  process.env.TWILIO_FROM_NUMBER = "+15875550100";
  db();
});
afterEach(() => { delete process.env.TWILIO_FROM_NUMBER; vi.restoreAllMocks(); });

describe("the cheap pre-check", () => {
  it("spots a token", () => {
    expect(hasMergeFields("Hi {{contact.first_name}}")).toBe(true);
  });

  it("ignores ordinary text, so no lookup is paid for", () => {
    expect(hasMergeFields("Hi Todd, your docs are ready")).toBe(false);
    expect(hasMergeFields("")).toBe(false);
  });

  it("is not fooled by a lone brace", () => {
    expect(hasMergeFields("cost {approx} 5k")).toBe(false);
  });
});

describe("SMS send resolves before Twilio", () => {
  it("checks for tokens first: plain text pays for no contact lookup", async () => {
    const res = await sendSms({ to: TO, contactId: CONTACT, body: "Hi Todd, your docs are ready" });
    expect(res.status).toBe(200);
    expect(callsMatching(queryMock, /LEFT JOIN companies co/)).toHaveLength(0);
    expect(createMock.mock.calls[0]![0].body).toBe("Hi Todd, your docs are ready");
  });

  it("looks the contact up by the id the composer already sends", async () => {
    await sendSms({ to: TO, contactId: CONTACT, body: "Hi {{contact.first_name}} from {{company.name}}" });
    const [call] = callsMatching(queryMock, /FROM contacts c\s+LEFT JOIN companies co/);
    expect(call).toBeDefined();
    expect(call![1]).toEqual([CONTACT]);
  });

  it("resolves before the body reaches Twilio, and the stored copy matches", async () => {
    const res = await sendSms({ to: TO, contactId: CONTACT, body: "Hi {{contact.first_name}} from {{company.name}}" });
    expect(res.status).toBe(200);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]![0].body).toBe("Hi Jordan from Lee Haulage");
    const [insert] = callsMatching(queryMock, "INSERT INTO communications_messages");
    expect((insert![1] as unknown[])[1]).toBe("Hi Jordan from Lee Haulage");
  });

  it("never lets a merge failure block the send", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    db([[/FROM contacts c\s+LEFT JOIN companies co/, new Error("db down")]]);
    const res = await sendSms({ to: TO, contactId: CONTACT, body: "Hi {{contact.first_name}}" });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith("[sms] merge-field render failed", expect.stringContaining("db down"));
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]![0].body).toBe("Hi {{contact.first_name}}");
  });
});

describe("what the client actually receives", () => {
  const ctx = {
    contact: { name: "Jordan Lee", first_name: null, email: null, phone: null },
    company: { name: "Lee Haulage" },
  };

  it("fills the name", () => {
    expect(renderMergeFields("Hi {{contact.first_name}}, your docs are ready.", ctx))
      .toBe("Hi Jordan, your docs are ready.");
  });

  it("leaves an unresolvable token visible rather than sending a hole", () => {
    // "Hi ," reaching a client is worse than a visible token, because nobody
    // notices it in the sent log.
    expect(renderMergeFields("Call {{user.phone}} to confirm.", ctx))
      .toBe("Call {{user.phone}} to confirm.");
  });
});
