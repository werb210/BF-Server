// BF_SERVER_MEETING_LINK_v70 - {{meeting_link}} was offered by the Templates
// UI from v693 and resolved nowhere, so it sent literal braces to recipients.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MERGE_FIELD_NAMES } from "../services/mergeFields.js";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

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
const BOOKING = "https://outlook.office.com/book/todd@boreal.financial";
const token = () => jwt.sign({ sub: STAFF_ID, id: STAFF_ID, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
let bookingUrl: string | null = BOOKING;

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
    .send({ to: ["client@example.com"], subject: "Hello", body_html });
  expect(res.status).toBe(200);
  const send = graphFetch.mock.calls.find(([url]) => url === "/me/sendMail")!;
  return JSON.parse(send[1].body).message.body.content as string;
}

beforeEach(() => {
  bookingUrl = BOOKING;
  queryMock.mockReset();
  createMock.mockReset();
  graphFetch.mockReset();
  createMock.mockResolvedValue({ sid: "SM1", status: "queued" });
  graphFetch.mockImplementation(async () => new Response("{}", { status: 202 }));
  process.env.TWILIO_FROM_NUMBER = "+15875550100";
  queryMock.mockImplementation(answerBySql([
    [/SELECT booking_url FROM user_settings/, () => ({ rows: bookingUrl == null ? [] : [{ booking_url: bookingUrl }] })],
    [/FROM contacts/, { rows: [] }],
  ]));
});
afterEach(() => { delete process.env.TWILIO_FROM_NUMBER; });

describe("the token now resolves", () => {
  it("is in the email context", async () => {
    const html = await emailBody("<p>{{meeting_link}}</p>");
    expect(html).not.toContain("{{meeting_link}}");
    expect(html).toContain(`href="${BOOKING}"`);
  });

  it("is in the SMS context", async () => {
    expect(await smsBody("Book here: {{meeting_link}}")).toBe(`Book here: ${BOOKING}`);
  });

  it("is in the messenger context (no sender link there, so it resolves to empty rather than braces)", async () => {
    const res = await request(await app()).post("/api/communications/messages/send").set("Authorization", `Bearer ${token()}`)
      .send({ contactId: CONTACT, body: "Book: {{meeting_link}}" });
    expect(res.status).toBe(201);
    const [insert] = callsMatching(queryMock, "INSERT INTO communications_messages");
    expect((insert![1] as unknown[])[4]).toBe("Book: ");
  });

  it("reads the sender's own booking link", async () => {
    await smsBody("{{meeting_link}}");
    await emailBody("{{meeting_link}}");
    const lookups = callsMatching(queryMock, /SELECT booking_url FROM user_settings/);
    expect(lookups.length).toBe(2);
    for (const c of lookups) expect(c[1]).toEqual([STAFF_ID]);
  });
});

describe("the shape suits the channel", () => {
  it("email gets a button", async () => {
    expect(await emailBody("{{meeting_link}}")).toContain("Book a meeting</a>");
  });

  it("on the brand navy, not the old indigo", async () => {
    const html = await emailBody("{{meeting_link}}");
    expect(html).toContain("background:#0B1F3A");
    expect(html).not.toContain("background:#1E3A8A");
  });

  it("SMS gets the bare url, with no markup", async () => {
    const text = await smsBody("{{meeting_link}}");
    expect(text).toBe(BOOKING);
    expect(text).not.toContain("<a href");
  });
});

describe("it degrades quietly", () => {
  it("resolves to empty rather than leaving braces when unset", async () => {
    bookingUrl = null;
    expect(await smsBody("Book: {{meeting_link}}")).toBe("Book: ");
    const html = await emailBody("<p>Book: {{meeting_link}}</p>");
    expect(html).toContain("<p>Book: </p>");
    expect(html).not.toContain("{{");
  });
});

describe("the catalogue can offer it honestly now", () => {
  it("is in the live set", () => {
    expect(MERGE_FIELD_NAMES).toContain("meeting_link");
  });
});
