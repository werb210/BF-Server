// Maya marketing tools: an overview read and a send that only previews unless confirm === true.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, h } = vi.hoisted(() => ({ queryMock: vi.fn(), h: { sent: [] as any[], sms: [] as any[], ran: [] as any[] } }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock } };
});
vi.mock("../services/sendgridService.js", () => ({
  sendgridConfigured: () => true,
  sendOne: async (m: any) => { h.sent.push(m); return { ok: true }; },
  mergeFields: (s: string) => s,
}));
vi.mock("../services/marketingSms.js", () => ({
  smsMarketingConfigured: () => true,
  sendMarketingSms: async (to: string) => { h.sms.push(to); return { ok: true }; },
  renderMarketingSms: (o: any) => o.body,
}));
vi.mock("../services/marketingSendRunner.js", () => ({
  countEmailRecipients: async () => 12,
  countSmsRecipients: async () => 7,
  runEmailSend: async (_p: unknown, o: any) => { h.ran.push(o); return { total: 12, sent: 12, failed: 0 }; },
  runSmsSend: async (...a: unknown[]) => { h.ran.push(a); return {}; },
  phone10: (p: string | null | undefined) => String(p ?? "").replace(/[^0-9]/g, "").slice(-10),
}));
vi.mock("../services/landingPage.service.js", () => ({
  createLandingPageFromHtml: async () => ({ url: "https://x.test/v" }),
  withViewInBrowser: (html: string) => html,
}));

import mayaStaff from "../routes/mayaStaff.js";

const STAFF = "11111111-1111-4111-8111-111111111111";
const app = express();
app.use(express.json());
app.use("/api/maya", mayaStaff);
const svc = () => "Bearer " + jwt.sign({ kind: "service", source: "agent" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const post = (p: string, body: Record<string, unknown>) => request(app).post("/api/maya" + p).set("Authorization", svc()).send(body);

beforeEach(() => {
  h.sent.length = 0; h.sms.length = 0; h.ran.length = 0;
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/INSERT INTO maya_pending_actions/, { rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001" }] }],
    [/unnest\(tags\)[\s\S]*COALESCE\(email/, { rows: [{ tag: "vip", n: 5 }] }],
    [/unnest\(tags\)[\s\S]*COALESCE\(phone/, { rows: [{ tag: "vip", n: 3 }, { tag: "new", n: 1 }] }],
    [/count\(\*\)::int AS n FROM contacts WHERE silo = \$1 AND COALESCE\(email/, { rows: [{ n: 20 }] }],
    [/count\(\*\)::int AS n FROM contacts WHERE silo = \$1 AND COALESCE\(phone/, { rows: [{ n: 9 }] }],
    [/FROM marketing_send_jobs/, { rows: [{ id: "j1", channel: "email", status: "done" }] }],
  ]));
});

describe("Maya marketing tools", () => {
  it("exposes overview + gated send", async () => {
    const o = await post("/staff/marketing-overview", { silo: "BF" });
    expect(o.status).toBe(200);
    expect(o.body.email).toEqual({ configured: true, all: 20, segments: [{ tag: "vip", n: 5 }] });
    expect(o.body.sms).toMatchObject({ configured: true, all: 9 });
    expect(o.body.recentJobs).toHaveLength(1);
    const s = await post("/staff/marketing-send", { channel: "email", tag: "vip", subject: "Hi", html: "<p>Hi</p>", user_id: STAFF });
    expect(s.status).toBe(200);
    for (const p of ["/staff/marketing-overview", "/staff/marketing-send"]) {
      expect((await request(app).post("/api/maya" + p).send({})).status).toBe(401);
    }
  });

  it("gates send behind confirm===true (preview otherwise)", async () => {
    for (const confirm of [undefined, false, "true", 1]) {
      const email = await post("/staff/marketing-send", { channel: "email", tag: "vip", subject: "Hi", html: "<p>Hi</p>", user_id: STAFF, confirm });
      expect(email.body).toMatchObject({ ok: true, preview: true, channel: "email", recipients: 12 });
      const sms = await post("/staff/marketing-send", { channel: "sms", tag: "vip", body: "Rates dropped", user_id: STAFF, confirm });
      expect(sms.body).toMatchObject({ ok: true, preview: true, channel: "sms", recipients: 7 });
    }
    expect(h.sent).toEqual([]);
    expect(h.sms).toEqual([]);
    expect(h.ran).toEqual([]);
    expect(callsMatching(queryMock, /INSERT INTO marketing_send_jobs/)).toHaveLength(0);
  });

  it("confirm === true leaves the preview path (and then needs the preview's id)", async () => {
    const r = await post("/staff/marketing-send", { channel: "email", tag: "vip", subject: "Hi", html: "<p>Hi</p>", user_id: STAFF, confirm: true });
    expect(r.body.preview).toBeUndefined();
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("pending_action_required");
  });
});
