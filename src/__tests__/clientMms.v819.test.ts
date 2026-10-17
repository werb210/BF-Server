// BF_SERVER_v819_CLIENT_MMS - a picture the client texted in reaches the client chat as an attachment served by an
// owner-guarded media route, never as a "[media]" bubble and never with the stored media URL.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_APP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MSG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OWNER = "+15875550123";
const BLOB = "https://store.blob.core.windows.net/mms-inbound/sms/abc.png";
const TWILIO = "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1";

const h = vi.hoisted(() => ({ query: vi.fn(), fetchTwilioMedia: vi.fn(), persist: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../routes/clientDocumentsNeeded.js", async (orig) => ({ ...(await orig<any>()), computeOutstandingDocs: async () => ({ required: [], stillNeeded: [], rejected: [] }) }));
vi.mock("../services/mmsMedia.js", () => ({ fetchTwilioMedia: h.fetchTwilioMedia, persistTwilioMediaToBlob: h.persist }));

import clientRouter from "../routes/client/index.js";

const app = express();
app.use(express.json());
app.use("/api/client", clientRouter);

const tokenFor = (phone: string) =>
  "Bearer " + jwt.sign({ sub: "client:" + phone, role: "client", phone, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });

let owns = true;
let mediaRow: Record<string, unknown> | null = { media_url: BLOB };
const fetchMock = vi.fn();

beforeEach(() => {
  owns = true;
  mediaRow = { media_url: BLOB };
  h.query.mockReset();
  h.fetchTwilioMedia.mockReset();
  h.persist.mockReset();
  h.query.mockImplementation(answerBySql([
    [/FROM applications WHERE lower\(id::text\) = ANY/, (_s: string, p?: unknown[]) => ({ rows: ((p?.[0] as string[]) ?? []).filter((x) => x === APP || x === OTHER_APP).map((id) => ({ id })) })],
    [/WITH app_phones AS/, (_s: string, p?: unknown[]) => ({ rows: [{ total: p?.[0] === APP ? 1 : 0, mine: owns ? 1 : 0, known: 1 }] })],
    [/SELECT media_url\s+FROM communications_messages/, () => ({ rows: mediaRow ? [mediaRow] : [] })],
    [/WITH thread AS/, { rows: [
      { id: "m1", direction: "outbound", body: "Hi from staff", staff_name: "Todd", attachments: null, type: "chat", media_url: null, created_at: "2026-10-01T00:00:00Z" },
      { id: MSG, direction: "inbound", body: "[media]", attachments: null, type: "sms", media_url: TWILIO, created_at: "2026-10-01T00:01:00Z" },
      { id: "m3", direction: "inbound", body: "Here is the invoice", attachments: [{ name: "a.pdf", dataUrl: "data:application/pdf;base64,AA" }], type: "sms", media_url: "https://store.blob.core.windows.net/mms-inbound/sms/x.pdf", created_at: "2026-10-01T00:02:00Z" },
    ] }],
  ]));
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("GET /api/client/messages - texted pictures", () => {
  it("turns media rows into an attachment and never sends media_url", async () => {
    const r = await request(app).get(`/api/client/messages?applicationId=${APP}`).set("Authorization", tokenFor(OWNER));
    expect(r.status).toBe(200);
    const [staff, pic, pdf] = r.body.data;
    expect(staff.body).toBe("Hi from staff");
    expect(staff.attachments).toBeNull();
    expect(pic.body).toBe("");
    expect(pic.attachments).toEqual([
      { name: "Picture", contentType: "image/jpeg", url: `/api/client/messages/${MSG}/media?applicationId=${APP}` },
    ]);
    expect(pdf.body).toBe("Here is the invoice");
    expect(pdf.attachments).toHaveLength(2);
    expect(pdf.attachments[0]).toEqual({ name: "a.pdf", dataUrl: "data:application/pdf;base64,AA" });
    expect(pdf.attachments[1]).toMatchObject({ name: "File", contentType: "application/pdf" });
    expect(JSON.stringify(r.body)).not.toContain("twilio.com");
    expect(JSON.stringify(r.body)).not.toContain("blob.core.windows.net");
    expect(sqlText(callsMatching(h.query, /WITH thread AS/)[0]![0])).toMatch(/type, media_url/);
  });
});

describe("GET /api/client/messages/:id/media", () => {
  const url = `/api/client/messages/${MSG}/media?applicationId=${APP}`;

  it("streams a stored blob copy to the owner", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } }));
    const r = await request(app).get(url).set("Authorization", tokenFor(OWNER)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.headers["cache-control"]).toMatch(/^private/);
    expect([...(r.body as Buffer)]).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledWith(BLOB);
  });

  it("uses the thread WHERE scoped to the application and the message id", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "image/png" } }));
    await request(app).get(url).set("Authorization", tokenFor(OWNER));
    const [call] = callsMatching(h.query, /SELECT media_url\s+FROM communications_messages/);
    const sql = sqlText(call![0]);
    expect(sql).toContain("application_id::text = ($1)::text");
    expect(sql).toContain("application_id IS NULL");
    expect(sql).toContain("contact_id::text = (SELECT contact_id::text FROM thread)");
    expect(sql).toContain("id::text = ($2)::text");
    expect(call![1]).toEqual([APP, MSG]);
  });

  it("fetches a raw Twilio URL with the shared helper and saves the blob copy", async () => {
    mediaRow = { media_url: TWILIO };
    h.persist.mockResolvedValue({ url: BLOB, contentType: "image/jpeg", buffer: Buffer.from([9]) });
    const r = await request(app).get(url).set("Authorization", tokenFor(OWNER));
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/jpeg");
    expect(h.persist).toHaveBeenCalledWith(TWILIO);
    const [upd] = callsMatching(h.query, /UPDATE communications_messages SET media_url/);
    expect(upd![1]).toEqual([MSG, BLOB]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s a message that is not in this application's thread", async () => {
    mediaRow = null;
    const r = await request(app).get(url).set("Authorization", tokenFor(OWNER));
    expect(r.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a client who does not own the application", async () => {
    owns = false;
    const r = await request(app).get(url).set("Authorization", tokenFor("+15875559999"));
    expect(r.status).toBe(403);
    expect(callsMatching(h.query, /SELECT media_url\s+FROM communications_messages/)).toHaveLength(0);
  });

  it("refuses a request with no token", async () => {
    const r = await request(app).get(url);
    expect(r.status).toBe(401);
    expect(callsMatching(h.query, /SELECT media_url\s+FROM communications_messages/)).toHaveLength(0);
  });

  it("404s an unknown application or a missing applicationId", async () => {
    const unknown = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    expect((await request(app).get(`/api/client/messages/${MSG}/media?applicationId=${unknown}`).set("Authorization", tokenFor(OWNER))).status).toBe(404);
    expect((await request(app).get(`/api/client/messages/${MSG}/media`).set("Authorization", tokenFor(OWNER))).status).toBe(404);
    expect(callsMatching(h.query, /SELECT media_url\s+FROM communications_messages/)).toHaveLength(0);
  });

  it("never serves an unsafe stored type inline", async () => {
    fetchMock.mockResolvedValue(new Response("<script>", { status: 200, headers: { "content-type": "text/html" } }));
    const r = await request(app).get(url).set("Authorization", tokenFor(OWNER));
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/octet-stream");
    expect(r.headers["content-disposition"]).toBe("attachment");
  });
});
