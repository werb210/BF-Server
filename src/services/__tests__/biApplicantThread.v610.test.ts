// BF_SERVER_BLOCK_v610_BI_THREAD
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { biContactForPhone, biMarkReadForPhone, biSendForPhone, biThreadForPhone, biUnreadForPhone, cleanAttachments } from "../biApplicantThread.js";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";

const { poolQuery, sendSmsMock, pushMock, passkeyLogin, passkeyLoginOptions } = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  sendSmsMock: vi.fn(),
  pushMock: vi.fn(),
  passkeyLogin: vi.fn(),
  passkeyLoginOptions: vi.fn(),
}));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: poolQuery }, runQuery: poolQuery, dbQuery: poolQuery };
});
vi.mock("../../modules/notifications/sms.service.js", () => ({ sendSms: sendSmsMock }));
vi.mock("../notifications/notifyClient.js", () => ({ pushToClientApp: pushMock }));
vi.mock("../../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: vi.fn(async () => undefined) }));
vi.mock("../clientPasskeys.js", async () => {
  const actual = await vi.importActual<typeof import("../clientPasskeys.js")>("../clientPasskeys.js");
  return { ...actual, loginWithPasskey: passkeyLogin, loginOptions: passkeyLoginOptions };
});

function db(existing = true) {
  const msgs: any[] = [];
  const contacts: any[] = existing ? [{ id: "c-1", phone: "(780) 555-1212" }] : [];
  const query = vi.fn(async (sql: string, p: any[]) => {
    if (sql.includes("FROM contacts")) return { rows: contacts.filter((c) => c.phone.replace(/\D/g, "").slice(-10) === p[0]) };
    if (sql.startsWith("INSERT INTO contacts")) { contacts.push({ id: "c-new", phone: p[0] }); return { rows: [{ id: "c-new" }] }; }
    if (sql.includes("COUNT(*)::int AS n")) return { rows: [{ n: msgs.filter((m) => m.contact_id === p[0] && m.direction === "outbound" && !m.read_at).length }] };
    if (sql.startsWith("UPDATE communications_messages SET read_at")) { const hit = msgs.filter((m) => m.contact_id === p[0] && m.direction === "outbound" && !m.read_at); hit.forEach((m) => { m.read_at = "now"; }); return { rows: hit }; }
    if (sql.startsWith("INSERT INTO communications_messages")) { const m = { id: `m${msgs.length + 1}`, contact_id: p[0], body: p[1], direction: "inbound", attachments: JSON.parse(p[3]), created_at: "t" }; msgs.push(m); return { rows: [m] }; }
    if (sql.includes("FROM communications_messages")) return { rows: msgs.filter((m) => m.contact_id === p[0]).slice().reverse() };
    return { rows: [] };
  });
  return { query, msgs };
}

const BRIDGE_TOKEN = "bridge-token-v610";
beforeEach(() => {
  poolQuery.mockReset();
  sendSmsMock.mockReset();
  sendSmsMock.mockResolvedValue({ sid: "SM1" });
  pushMock.mockReset();
  pushMock.mockResolvedValue(false);
  process.env.BACKEND_SERVICE_TOKEN = BRIDGE_TOKEN;
  process.env.BI_SERVER_URL = "https://bi.test.local";
});
afterEach(() => { delete process.env.BACKEND_SERVICE_TOKEN; delete process.env.BI_SERVER_URL; vi.unstubAllGlobals(); });

describe("BI applicant thread by phone", () => {
  it("finds or creates the BI contact from the phone", async () => {
    expect(await biContactForPhone(db().query as any, "+17805551212")).toBe("c-1");
    expect(await biContactForPhone(db(false).query as any, "+17805551212")).toBe("c-new");
    expect(await biContactForPhone(db().query as any, "12")).toBeNull();
  });

  it("sends, lists in the app's shape, counts and clears unread", async () => {
    const d = db();
    const sent = await biSendForPhone(d.query as any, "+17805551212", "Here is my contract", cleanAttachments([{ name: "c.pdf", contentType: "application/pdf", dataUrl: "data:application/pdf;base64,AA" }, { name: "x", dataUrl: "http://no" }]));
    expect(sent).toMatchObject({ body: "Here is my contract", sender: "applicant", attachments: [{ name: "c.pdf", url: "data:application/pdf;base64,AA" }] });
    d.msgs.push({ id: "m9", contact_id: "c-1", body: "Thanks!", direction: "outbound", staff_name: "Andrew", created_at: "t2" });
    const thread = await biThreadForPhone(d.query as any, "+17805551212");
    expect(thread?.messages.map((m) => [m.sender, m.body])).toEqual([["applicant", "Here is my contract"], ["staff", "Thanks!"]]);
    expect(thread?.unreadCount).toBe(1);
    expect(await biMarkReadForPhone(d.query as any, "+17805551212")).toBe(1);
    expect(await biUnreadForPhone(d.query as any, "+17805551212")).toBe(0);
  });
});

describe("the service bridge serves the applicant thread", () => {
  async function bridge() {
    const router = (await import("../../routes/serviceBridge.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/service", router);
    return app;
  }
  const PHONE = "+17805551212";

  it("GET/POST /applicant-messages, /unread and /read work by the applicant's phone", async () => {
    const d = db();
    poolQuery.mockImplementation(d.query);
    const app = await bridge();
    const auth = (r: request.Test) => r.set("x-backend-token", BRIDGE_TOKEN).set("x-applicant-phone", PHONE);

    const posted = await auth(request(app).post("/api/service/applicant-messages")).send({ body: "Here is my contract" });
    expect(posted.status).toBe(201);
    expect(posted.body).toMatchObject({ ok: true, body: "Here is my contract", sender: "applicant" });

    d.msgs.push({ id: "m9", contact_id: "c-1", body: "Thanks!", direction: "outbound", staff_name: "Andrew", created_at: "t2" });
    const thread = await auth(request(app).get("/api/service/applicant-messages"));
    expect(thread.status).toBe(200);
    expect(thread.body.messages.map((m: any) => m.body)).toEqual(["Here is my contract", "Thanks!"]);

    expect((await auth(request(app).get("/api/service/applicant-messages/unread"))).body).toEqual({ unreadCount: 1 });
    expect((await auth(request(app).post("/api/service/applicant-messages/read"))).body).toEqual({ ok: true, marked: 1 });
    expect((await auth(request(app).get("/api/service/applicant-messages/unread"))).body).toEqual({ unreadCount: 0 });
  });

  it("addresses the applicant by phone, not by contact id", async () => {
    poolQuery.mockImplementation(db().query);
    const app = await bridge();
    const res = await request(app).post("/api/service/applicant-messages").set("x-backend-token", BRIDGE_TOKEN).send({ contact_id: "c-1", body: "hi" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("phone_and_body_required");
    const noPhone = await request(app).get("/api/service/applicant-messages").set("x-backend-token", BRIDGE_TOKEN);
    expect(noPhone.body.error).toBe("applicant_phone_required");
  });

  it("is closed without the service token", async () => {
    const app = await bridge();
    expect((await request(app).get("/api/service/applicant-messages").set("x-applicant-phone", PHONE)).status).toBe(401);
  });
});

describe("a staff reply to a BI applicant", () => {
  const STAFF_ID = "00000000-0000-4000-8000-0000000000a1";
  const CONTACT = "11111111-2222-4333-8444-555555555555";
  async function reply(silo: "BI" | "BF") {
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }); }));
    poolQuery.mockImplementation(answerBySql([
      [/SELECT phone FROM contacts WHERE id::text = \$1/, { rows: [{ phone: "+17805551212" }] }],
      [/MAX\(a\.last_portal_seen_at\)/, { rows: [{ last_seen: null, phone: "+17805551212", seconds_since: null }] }],
    ]));
    const router = (await import("../../routes/communications.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/communications", router);
    const tok = jwt.sign({ sub: STAFF_ID, id: STAFF_ID, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
    const res = await request(app).post("/api/communications/messages/send").set("Authorization", `Bearer ${tok}`).set("X-Silo", silo)
      .send({ contactId: CONTACT, body: "We got it" });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 10));
    return calls;
  }

  it("is handed to BI-Server with the applicant's phone, and never takes the BF offline SMS fallback", async () => {
    const calls = await reply("BI");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://bi.test.local/api/v1/bi/applicant-messages/from-bf");
    expect(calls[0]!.body).toMatchObject({ contact_id: CONTACT, phone: "+17805551212", body: "We got it" });
    expect(pushMock).not.toHaveBeenCalled();
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("a BF client who is away still gets the fallback (control)", async () => {
    const calls = await reply("BF");
    expect(calls).toHaveLength(0);
    await vi.waitFor(() => expect(sendSmsMock).toHaveBeenCalledTimes(1));
  });
});

describe("passkey path aliases", () => {
  async function app() {
    const passkeys = (await import("../../routes/client/passkeys.js")).default;
    const a = express(); a.use(express.json()); a.use("/api/client", passkeys);
    return a;
  }
  it("registration/authentication names reach the real handlers", async () => {
    const a = await app();
    expect((await request(a).post("/api/client/passkeys/registration/options")).status).toBe(401); // needs a client session, like register/options
    expect((await request(a).post("/api/client/passkeys/nope")).status).toBe(404);
  });
  it("authentication/options and authentication/verify reach the login handlers", async () => {
    passkeyLoginOptions.mockResolvedValue({ challenge: "ch-1" });
    passkeyLogin.mockResolvedValue({ ok: false, error: "unknown_credential" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const a = await app();
    const opts = await request(a).post("/api/client/passkeys/authentication/options");
    expect(opts.status).toBe(200);
    expect(opts.body).toEqual({ challenge: "ch-1" });
    const verify = await request(a).post("/api/client/passkeys/authentication/verify").send({ id: "cred-1" });
    expect(verify.status).toBe(401);
    expect(verify.body).toEqual({ error: "unknown_credential" });
    expect(passkeyLogin).toHaveBeenCalledWith(expect.any(Function), { id: "cred-1" }, expect.any(String));
  });
});
