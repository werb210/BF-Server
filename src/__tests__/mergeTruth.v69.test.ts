// BF_SERVER_MERGE_TRUTH_v69 - the Snippets picker offered dotted tokens that
// no live renderer understands, so a snippet written from it sent the braces
// to the client.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MERGE_FIELD_NAMES, LIVE_MERGE_FIELDS } from "../services/mergeFields.js";
import { answerBySql } from "./helpers/answerBySql.js";

const { queryMock, createMock, graphFetch } = vi.hoisted(() => ({ queryMock: vi.fn(), createMock: vi.fn(), graphFetch: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock };
});
vi.mock("../lib/sharedClients.js", () => ({
  sharedTwilio: () => ({ messages: { create: createMock } }),
  sharedOpenAI: () => ({}),
}));
vi.mock("../modules/o365/graphClient.js", () => ({ getGraphForUser: vi.fn(async () => ({ fetch: graphFetch })) }));
vi.mock("../services/biOutreach.js", () => ({ bumpBiOutreachToContacted: vi.fn(async () => undefined) }));

const STAFF_ID = "00000000-0000-4000-8000-0000000000a1";
const CONTACT = "11111111-2222-4333-8444-555555555555";
const TO = "+15874441234";
const BOOKING = "https://book.example/todd";
const token = () => jwt.sign({ sub: STAFF_ID, id: STAFF_ID, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const ROW = { first_name: "Jordan", last_name: "Lee", name: "Jordan Lee", email: "jordan@lee.test" };
let contactRow: typeof ROW | null = ROW;

async function app() {
  const comms = (await import("../routes/communications.js")).default;
  const o365 = (await import("../routes/o365.js")).default;
  const a = express();
  a.use(express.json());
  a.use("/api/communications", comms);
  a.use("/api/o365", o365);
  return a;
}
async function smsBody(body: string): Promise<string> {
  const res = await request(await app()).post("/api/communications/sms").set("Authorization", `Bearer ${token()}`).send({ to: TO, contactId: CONTACT, body });
  expect(res.status).toBe(200);
  return createMock.mock.calls.at(-1)![0].body;
}
async function emailBody(body_html: string): Promise<string> {
  const res = await request(await app()).post("/api/o365/mail/send").set("Authorization", `Bearer ${token()}`)
    .send({ to: ["jordan@lee.test"], subject: "Hello", body_html });
  expect(res.status).toBe(200);
  const send = graphFetch.mock.calls.find(([url]) => url === "/me/sendMail")!;
  return JSON.parse(send[1].body).message.body.content as string;
}
const allTokens = (names: readonly string[]) => names.map((n) => `${n}=[{{${n}}}]`).join(" ");

beforeEach(() => {
  contactRow = ROW;
  queryMock.mockReset();
  createMock.mockReset();
  graphFetch.mockReset();
  createMock.mockResolvedValue({ sid: "SM1", status: "queued" });
  graphFetch.mockImplementation(async () => new Response("{}", { status: 202 }));
  process.env.TWILIO_FROM_NUMBER = "+15875550100";
  queryMock.mockImplementation(answerBySql([
    [/SELECT booking_url FROM user_settings/, { rows: [{ booking_url: BOOKING }] }],
    [/SELECT first_name, last_name, name, email FROM contacts/, () => ({ rows: contactRow ? [contactRow] : [] })],
  ]));
});
afterEach(() => { delete process.env.TWILIO_FROM_NUMBER; });

describe("the catalogue matches what actually renders", () => {
  it("offers flat tokens, not dotted ones", () => {
    for (const name of MERGE_FIELD_NAMES) {
      expect(name).not.toContain(".");
    }
  });

  it("offers exactly the live set", () => {
    // BF_SERVER_MEETING_LINK_v70 - meeting_link became real, so it joins the set.
    expect(MERGE_FIELD_NAMES).toEqual(["first_name", "last_name", "full_name", "name", "email", "meeting_link"]);
  });

  it("every offered token is built by the SMS context", async () => {
    const text = await smsBody(allTokens(LIVE_MERGE_FIELDS));
    expect(text).not.toContain("{{");
    expect(text).toBe(
      `first_name=[Jordan] last_name=[Lee] full_name=[Jordan Lee] name=[Jordan Lee] email=[jordan@lee.test] meeting_link=[${BOOKING}]`,
    );
  });

  it("every offered token is built by the email context", async () => {
    const html = await emailBody(allTokens(["first_name", "last_name", "name", "email"]));
    expect(html).toContain("first_name=[Jordan] last_name=[Lee] name=[Jordan Lee] email=[jordan@lee.test]");
  });
});

describe("the live renderers can parse what is offered", () => {
  // renderMergeTokensComm matches /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/ - no dots.
  const pattern = /^[a-zA-Z0-9_]+$/;

  it("no offered token would fail the renderer's own regex", () => {
    for (const name of MERGE_FIELD_NAMES) {
      expect(pattern.test(name)).toBe(true);
    }
  });
});

describe("email resolves on SMS as well as email", () => {
  it("is in the SMS context defaults: no contact means empty, not braces", async () => {
    contactRow = null;
    expect(await smsBody("name=[{{name}}] email=[{{email}}]")).toBe("name=[] email=[]");
  });

  it("is populated from the contact row", async () => {
    expect(await smsBody("Reply to {{email}}")).toBe("Reply to jordan@lee.test");
  });
});
