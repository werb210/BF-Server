// BF_SERVER_REPORTS6_10_v780 / BF_SERVER_SMS_KEYWORDS_v780 / BF_SERVER_MMS_DIAG_v780
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { answerBySql, callsMatching, type SqlRule } from "./helpers/answerBySql.js";

const { queryMock, persistMock, fetchMediaMock } = vi.hoisted(() => ({ queryMock: vi.fn(), persistMock: vi.fn(), fetchMediaMock: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  return { ...real, pool: { query: queryMock } };
});
// role "anon" = the header auth let the request through without a user (the media route's own last check).
let role = "Admin";
vi.mock("../middleware/auth.js", () => {
  const pass = () => (_req: any, _res: any, next: any) => next();
  return {
    requireAuth: (req: any, _res: any, next: any) => { if (role !== "anon") req.user = { id: "u1", role }; next(); },
    requireCapability: pass,
    requireAuthorization: pass,
  };
});
vi.mock("../middleware/twilioWebhookValidation.js", () => ({ twilioWebhookValidation: (_req: any, _res: any, next: any) => next() }));
vi.mock("../services/mmsMedia.js", () => ({
  persistTwilioMediaToBlob: persistMock,
  fetchTwilioMedia: fetchMediaMock,
  uploadInboundMmsBlob: vi.fn(async () => null),
}));
import { smsKeywordReply } from "../routes/smsInboundWebhook.js";
import reportsSection from "../routes/reportsSection.js";
import { DATA } from "../services/reports/data.js";

function db(rules: SqlRule[] = []) {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql(rules, { rows: [], rowCount: 1 }));
}
beforeEach(() => { role = "Admin"; db(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function inbound(body: string) {
  const router = (await import("../routes/smsInboundWebhook.js")).default;
  const app = express();
  app.use(router);
  return request(app).post("/webhooks/twilio/sms-inbound").type("form").send({ From: "+15874441234", To: "+15875550100", Body: body, MessageSid: "SMin1" });
}

describe("SMS keywords match what Boreal registered with Twilio", () => {
  it("STOP and French ARRET opt out with the registered wording", () => {
    expect(smsKeywordReply("STOP")).toEqual({ kind: "out", text: "Boreal Financial: You've been unsubscribed and won't receive any more messages. Reply START to resubscribe." });
    expect(smsKeywordReply("ARRET")?.kind).toBe("out");
  });
  it("HELP, AIDE and INFO get the support reply; normal words get nothing", () => {
    expect(smsKeywordReply("HELP")?.text).toContain("Standard message & data rates may apply");
    expect(smsKeywordReply("AIDE")?.text).toContain("R\u00e9pondez ARRET");
    expect(smsKeywordReply("INFO")?.text).toContain(" / ");
    expect(smsKeywordReply("THANKS")).toBeNull();
  });
  it("YES resubscribes someone who is opted out", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    db([[/bool_or\(COALESCE\(sms_opt_out, false\)\) AS out/, { rows: [{ out: true }] }]]);
    const res = await inbound("Yes");
    expect(res.text).toContain("<Message>");
    const [upd] = callsMatching(queryMock, /UPDATE contacts SET sms_opt_out/);
    expect(upd![1]).toEqual(["5874441234", false]);
  });
  it("YES from someone who is not opted out reaches staff as a normal message", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    db([[/bool_or\(COALESCE\(sms_opt_out, false\)\) AS out/, { rows: [{ out: false }] }]]);
    const res = await inbound("Yes");
    expect(res.text).not.toContain("<Message>");
    expect(callsMatching(queryMock, /UPDATE contacts SET sms_opt_out/)).toHaveLength(0);
    expect(callsMatching(queryMock, /FROM communications_conversations/).length).toBeGreaterThan(0);
  });

  describe("image failures are logged with a reason", () => {
    const ID = "44444444-5555-4666-8777-888888888888";
    async function media(mediaUrl: string | null) {
      db([[/SELECT media_url FROM communications_messages/, { rows: [{ media_url: mediaUrl }] }]]);
      const router = (await import("../routes/communications.js")).default;
      const app = express();
      app.use("/api/communications", router);
      return request(app).get(`/api/communications/messages/${ID}/media`);
    }
    it("refused", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      role = "anon";
      expect((await media("https://blob.example/x.png")).status).toBe(401);
      expect(warn).toHaveBeenCalledWith("[mms-media] refused", { reason: "no_user" });
    });
    it("no media on message", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect((await media(null)).status).toBe(404);
      expect(warn).toHaveBeenCalledWith("[mms-media] no media on message", { id: ID });
    });
    it("twilio fetch failed", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      persistMock.mockResolvedValue(null);
      fetchMediaMock.mockResolvedValue(null);
      expect((await media("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1")).status).toBe(502);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[mms-media\] twilio fetch failed/), { id: ID });
    });
    it("stored copy unreadable", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).startsWith("https://blob.example/") ? new Response("gone", { status: 404 }) : new Response("?", { status: 599 }))));
      expect((await media("https://blob.example/x.png")).status).toBe(502);
      expect(warn).toHaveBeenCalledWith("[mms-media] stored copy unreadable", { id: ID, status: 404, host: "blob.example" });
    });
  });
});

describe("reports 6-10", () => {
  it("are all registered", () => {
    for (const k of ["pipeline_movement", "average_deal_size", "goals", "meetings", "tasks_report"]) expect(typeof (DATA as any)[k]).toBe("function");
  });
  it("only an Admin can set goals, and amounts are checked", async () => {
    const app = express(); app.use(express.json()); app.use("/api/reports", reportsSection);
    role = "Staff";
    expect((await request(app).put("/api/reports/goals").send({ userId: "00000000-0000-0000-0000-000000000099", fundingTarget: 1 })).status).toBe(403);
    role = "Admin";
    expect((await request(app).put("/api/reports/goals").send({ userId: "00000000-0000-0000-0000-000000000099", fundingTarget: -5 })).status).toBe(400);
    db();
    const ok = await request(app).put("/api/reports/goals").send({ userId: "00000000-0000-0000-0000-000000000099", fundingTarget: 500000, commissionTarget: "" });
    expect(ok.status).toBe(200);
    const [ins] = callsMatching(queryMock, "INSERT INTO report_goals");
    expect(ins![1]).toEqual(["00000000-0000-0000-0000-000000000099", 500000, null]);
  });
});
