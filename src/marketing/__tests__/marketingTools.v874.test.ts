// BF_SERVER_v874_MARKETING_TOOLS - behaviour of the marketing tools ported from KS-server #48 without plan limits:
// lead scores (rules, engagement, silo and record visibility), the A/B subject test and best-time sending (phases,
// the 09:00-20:00 window, the campaign ledger), the website kit (origins, consent, silo, the script), and where the
// new routes sit in the custom-role permission matrix. The database fake answers by SQL content.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { bearer } from "../../__tests__/helpers/staffToken.js";

const { queryMock, sendOne, submitKitLead, scopeOverride } = vi.hoisted(() => ({
  queryMock: vi.fn(), sendOne: vi.fn(), submitKitLead: vi.fn(), scopeOverride: { value: null as any },
}));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: queryMock }, dbQuery: queryMock }));
vi.mock("../../services/sendgridService.js", async (orig) => ({ ...(await orig<any>()), sendOne }));
vi.mock("../../modules/audit/audit.service.js", () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../kitLead.js", () => ({ submitKitLead }));
vi.mock("../../visibility/scope.js", async (orig) => {
  const real: any = await orig();
  return { ...real, scopeForRequest: async (req: any, db: any) => scopeOverride.value ?? real.scopeForRequest(req, db) };
});

import { computeScore, normalizeScoring, DEFAULT_SCORING, type ContactFacts } from "../leadScoring.js";
import { abSampleSize, bestHour, nextHourAt, parseCampaignOptions, pickWinner, runCampaignEmailJob, needsCampaignRunner } from "../campaignRunner.js";
import { kitScript } from "../kitScript.js";
import { kitConsentText, normalizeOrigin, originAllowed, parseSubmission, normalizeFields, type KitForm } from "../websiteKit.js";
import leadScoreRoutes from "../../routes/leadScores.js";
import { websiteKitAdminRoutes, websiteKitPublicRoutes } from "../../routes/websiteKit.js";
import { requiredPermission } from "../../roles/permissions.js";

const ALBERTA = "America/Regina"; // UTC-6 all year (lib/albertaTime.ts)

const facts = (over: Partial<ContactFacts> = {}): ContactFacts => ({
  id: "c1", phone: null, has_company: false, job_title: null, tags: [], lifecycle_stage: null, lead_status: null,
  requested_amount: null, activity: {}, ...over,
});

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([]));
  sendOne.mockReset();
  sendOne.mockResolvedValue({ ok: true, status: 202 });
  submitKitLead.mockReset();
  scopeOverride.value = null;
});

describe("lead score", () => {
  it("adds rule points and capped engagement, halves older activity, and grades hot / warm / cold", () => {
    const s = normalizeScoring(undefined);
    const cold = computeScore(facts(), s);
    expect(cold).toMatchObject({ score: 0, grade: "cold" });
    const warm = computeScore(facts({ phone: "403-555-0100", job_title: "Owner", tags: ["website_form"], requested_amount: 75000 }), s);
    expect(warm).toMatchObject({ rules_points: 10 + 10 + 10 + 10, engagement_points: 0, score: 40, grade: "warm" });
    expect(warm.breakdown.map((b) => b.label)).toContain("Asked for $50,000 or more");
    // 20 recent opens hit the 20-point cap; 4 older clicks count half (4 x 5 x 0.5 = 10); a submitted application 30.
    const hot = computeScore(facts({ phone: "4035550100", activity: { email_open: [20, 0], email_click: [0, 4], application_submitted: [1, 0] } }), s);
    expect(hot).toMatchObject({ rules_points: 10, engagement_points: 20 + 10 + 30, score: 70, grade: "hot" });
  });

  it("keeps settings in range and drops rules that need a value but have none", () => {
    const s = normalizeScoring({ rules: [{ kind: "tag", points: 99 }, { kind: "tag", value: "vip", points: 99 }, { kind: "nope", points: 5 }], hot: 30, warm: 80, engagement: { email_open: { points: -3, cap: 500 } } });
    expect(s.rules).toEqual([{ kind: "tag", value: "vip", points: 50 }]);
    expect(s.engagement.email_open).toEqual({ points: 0, cap: 100 });
    expect(s.hot).toBe(30);
    expect(s.warm).toBe(30); // never above hot
    expect(normalizeScoring({}).rules).toEqual(DEFAULT_SCORING.rules);
  });
});

describe("lead score routes", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/lead-scores", leadScoreRoutes);
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";

  it("scores only the request's silo with that silo's rules", async () => {
    queryMock.mockImplementation(answerBySql([
      [/SELECT value FROM boreal_settings WHERE key = \$1/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === "lead_scoring:BI" ? [{ value: { rules: [{ kind: "has_phone", points: 40 }], hot: 35, warm: 20 } }] : [] })],
      [/FROM contacts c WHERE c.id::text = ANY/, (_s: string, p?: unknown[]) => ({ rows: p?.[1] === "BI" ? [{ id: A, phone: "4035550100", has_company: false, job_title: null, tags: [], lifecycle_stage: null, lead_status: null, requested_amount: null }] : [] })],
    ]));
    const r = await request(app).post("/api/lead-scores/lookup").set("Authorization", bearer("Admin")).set("X-Silo", "BI").send({ contact_ids: [A, B] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, silo: "BI", hot: 35, warm: 20 });
    expect(r.body.scores[A]).toMatchObject({ score: 40, grade: "hot" });
    expect(Object.keys(r.body.scores)).toEqual([A]);
    const facts = callsMatching(queryMock, /FROM contacts c WHERE c.id::text = ANY/)[0][1] as unknown[];
    expect(facts[1]).toBe("BI");
    const saved = callsMatching(queryMock, /INSERT INTO lead_scores/)[0][1] as unknown[];
    expect(saved[1]).toBe("BI");
  });

  it("returns no score for a contact the person may not see (record visibility)", async () => {
    scopeOverride.value = { mode: "restricted", visibility: "own", userId: "u1", ownerIds: ["u1"] };
    queryMock.mockImplementation(answerBySql([
      [/SELECT r.id::text AS id FROM contacts r/, { rows: [{ id: A }] }],
      [/FROM contacts c WHERE c.id::text = ANY/, (_s: string, p?: unknown[]) => ({ rows: (p?.[0] as string[]).map((id) => ({ id, phone: null, has_company: true, job_title: null, tags: [], lifecycle_stage: null, lead_status: null, requested_amount: null })) })],
    ]));
    const r = await request(app).post("/api/lead-scores/lookup").set("Authorization", bearer("Staff")).send({ contact_ids: [A, B] });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.scores)).toEqual([A]);
    expect((callsMatching(queryMock, /FROM contacts c WHERE c.id::text = ANY/)[0][1] as unknown[])[0]).toEqual([A]);
  });

  it("lets Admins and Marketing users change the rules (per silo), not Staff", async () => {
    const denied = await request(app).put("/api/lead-scores/settings").set("Authorization", bearer("Staff")).send({ settings: {} });
    expect(denied.status).toBe(403);
    const ok = await request(app).put("/api/lead-scores/settings").set("Authorization", bearer("Marketing")).set("X-Silo", "BF").send({ settings: { hot: 60, warm: 30 } });
    expect(ok.status).toBe(200);
    const write = callsMatching(queryMock, /INSERT INTO boreal_settings/)[0][1] as unknown[];
    expect(write[0]).toBe("lead_scoring:BF");
    expect(JSON.parse(String(write[1]))).toMatchObject({ hot: 60, warm: 30 });
  });
});

describe("campaign send options", () => {
  it("reads the A/B test and best time, and refuses unclear choices in plain words", () => {
    expect(parseCampaignOptions({}, "Hello")).toEqual({ ok: true, value: {} });
    expect(parseCampaignOptions({ abTest: { subjectB: "Hi there", testPercent: 90, waitHours: 0 } }, "Hello")).toEqual({
      ok: true, value: { ab: { subjectB: "Hi there", testPercent: 50, waitHours: 1, phase: "test" } },
    });
    expect(parseCampaignOptions({ abTest: { subjectB: "Hello" } }, "Hello")).toMatchObject({ ok: false, error: "ab_subjects_same" });
    expect(parseCampaignOptions({ abTest: { subjectB: " " } }, "Hello")).toMatchObject({ ok: false, error: "ab_subject_required" });
    expect(parseCampaignOptions({ abTest: { subjectB: "B" }, sendTime: "best" }, "A")).toMatchObject({ ok: false, error: "ab_and_best_time" });
    expect(needsCampaignRunner({ sendTime: "best" })).toBe(true);
    expect(needsCampaignRunner({ subject: "plain" })).toBe(false);
  });

  it("picks the winner on opens, then clicks, and keeps A on a tie", () => {
    expect(pickWinner({ A: { sent: 10, opened: 2, clicked: 0 }, B: { sent: 10, opened: 3, clicked: 0 } })).toBe("B");
    expect(pickWinner({ A: { sent: 10, opened: 3, clicked: 1 }, B: { sent: 10, opened: 3, clicked: 2 } })).toBe("B");
    expect(pickWinner({ A: { sent: 10, opened: 3, clicked: 1 }, B: { sent: 10, opened: 3, clicked: 1 } })).toBe("A");
    expect(abSampleSize(100, 20)).toBe(20);
    expect(abSampleSize(5, 10)).toBe(2);
    expect(abSampleSize(1, 50)).toBe(1);
  });

  it("keeps each person's best hour inside 09:00-20:00 Alberta time", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 10, 2, h + 6, 15)); // h:15 Alberta time
    expect(bestHour([at(14), at(14), at(10)], ALBERTA)).toBe(14);
    expect(bestHour([at(6), at(6)], ALBERTA)).toBe(9);
    expect(bestHour([at(23)], ALBERTA)).toBe(19);
    expect(bestHour([], ALBERTA)).toBeNull();
    expect(nextHourAt(new Date("2026-11-02T18:30:00Z"), 9, ALBERTA).toISOString()).toBe("2026-11-03T15:00:00.000Z");
  });
});

describe("the campaign runner", () => {
  type Send = { id: string; contact_id: string; variant: string; status: string; opened_at: Date | null; scheduled_for: string | null };
  let sends: Send[];
  let people: Array<{ id: string; email: string; name: string; company: null }>;
  let opens: Array<{ contact_id: string; created_at: Date }>;
  const row = (payload: Record<string, unknown>) => ({ id: "job-1", silo: "BI", tag: "vip", payload: { subject: "Subject A", html: "<p>Hi {{first_name}}</p>", ...payload } });

  function fakePool() {
    let n = 0;
    return {
      query: vi.fn(answerBySql([
        [/SELECT contact_id::text AS contact_id FROM campaign_sends WHERE job_id/, () => ({ rows: sends.map((s) => ({ contact_id: s.contact_id })) })],
        [/FROM contacts c LEFT JOIN companies co ON co.id = c.company_id\s+WHERE c.silo/, () => ({ rows: people })],
        [/INSERT INTO campaign_sends[\s\S]*'scheduled'/, (_s: string, p?: unknown[]) => {
          sends.push({ id: `cs${++n}`, contact_id: String(p![1]), variant: "A", status: "scheduled", opened_at: null, scheduled_for: String(p![4]) });
          return { rows: [], rowCount: 1 };
        }],
        [/INSERT INTO campaign_sends/, (_s: string, p?: unknown[]) => {
          const s = { id: `cs${++n}`, contact_id: String(p![1]), variant: String(p![3]), status: "sent", opened_at: null, scheduled_for: null };
          sends.push(s);
          return { rows: [{ id: s.id }], rowCount: 1 };
        }],
        [/SELECT variant, COUNT/, () => ({ rows: ["A", "B"].map((v) => { const by = sends.filter((s) => s.variant === v); return { variant: v, sent: by.length, opened: by.filter((s) => s.opened_at).length, clicked: 0 }; }) })],
        [/COUNT\(\*\) FILTER \(WHERE status = 'sent'\)::int AS sent, COUNT\(\*\) FILTER \(WHERE status = 'failed'\)/, () => ({
          rows: [{ sent: sends.filter((s) => s.status === "sent").length, failed: 0, scheduled: sends.filter((s) => s.status === "scheduled").length }],
        })],
        [/FROM crm_timeline_events\s+WHERE contact_id::text = ANY/, () => ({ rows: opens })],
        [/SELECT MIN\(scheduled_for\)/, () => ({ rows: [{ at: sends.filter((s) => s.status === "scheduled").map((s) => s.scheduled_for!).sort()[0] ?? null }] })],
      ])),
    };
  }

  beforeEach(() => {
    sends = [];
    opens = [];
    people = Array.from({ length: 20 }, (_, i) => ({ id: `c${String(i).padStart(2, "0")}`, email: `p${i}@ex.ca`, name: `P ${i}`, company: null }));
  });

  it("A/B: sends the sample half A, half B, waits, then sends the winner to everyone else (no allowance)", async () => {
    const pool = fakePool();
    const ab = { subjectB: "Subject B", testPercent: 20, waitHours: 4, phase: "test" };
    const now = new Date("2026-11-02T18:00:00Z");
    const first = await runCampaignEmailJob(pool as any, row({ ab }), undefined, undefined, now);
    expect(first).toMatchObject({ status: "waiting", sent: 4 });
    expect(first.notBefore!.toISOString()).toBe("2026-11-02T22:00:00.000Z");
    expect(sends.map((s) => s.variant).sort()).toEqual(["A", "A", "B", "B"]);
    expect(sendOne.mock.calls[0][0].customArgs.cs_id).toMatch(/^cs\d+$/);
    expect((callsMatching(pool.query, /INSERT INTO campaign_sends/)[0][1] as unknown[])[2]).toBe("BI");
    for (const s of sends) if (s.variant === "B") s.opened_at = new Date();
    const second = await runCampaignEmailJob(pool as any, row({ ab: { ...ab, ...(first.payloadPatch!.ab as object) } }), undefined, undefined, now);
    expect(second).toMatchObject({ status: "done", sent: 20 });
    expect(second.error).toBeUndefined();
    expect((second.payloadPatch!.ab as any).winner).toBe("B");
    expect(new Set(sendOne.mock.calls.slice(4).map((c) => c[0].subject))).toEqual(new Set(["Subject B"]));
    expect(sendOne).toHaveBeenCalledTimes(20);
  });

  it("best time: sends now to people without history and schedules the rest inside the sending window", async () => {
    const pool = fakePool();
    const now = new Date("2026-11-02T18:00:00Z"); // 12:00 Alberta time
    // c00 reads at 06:xx Alberta time: scheduled for 09:00 tomorrow, never 06:00.
    opens = [{ contact_id: "c00", created_at: new Date("2026-10-20T12:15:00Z") }, { contact_id: "c00", created_at: new Date("2026-10-21T12:45:00Z") }];
    const step = await runCampaignEmailJob(pool as any, row({ sendTime: "best" }), undefined, undefined, now);
    expect(step.status).toBe("waiting");
    expect(step.notBefore!.toISOString()).toBe("2026-11-03T15:00:00.000Z");
    expect(step.payloadPatch).toEqual({ phase: "deliver" });
    expect(sendOne).toHaveBeenCalledTimes(19);
    expect(sends.find((s) => s.contact_id === "c00")).toMatchObject({ status: "scheduled" });
  });
});

describe("website kit", () => {
  const KEY = "a1b2c3d4e5f6a1b2c3d4e5f6";
  const FORM = "f0000000-0000-4000-8000-000000000001";
  let kit: Record<string, unknown>;
  const app = express();
  app.use(express.json());
  app.use("/api/website-kit", websiteKitAdminRoutes);
  app.use("/api/kit", websiteKitPublicRoutes);

  beforeEach(() => {
    kit = { key: KEY, allowed_origins: ["https://partner.example.ca"], chat_enabled: false, tracking_enabled: false, consent_banner: true };
    queryMock.mockImplementation(answerBySql([
      [/SELECT key, value FROM boreal_settings WHERE key = ANY/, () => ({ rows: [{ key: "website_kit:BI", value: kit }] })],
      [/SELECT value FROM boreal_settings WHERE key = \$1/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === "website_kit:BI" ? [{ value: kit }] : [] })],
      [/FROM website_kit_forms WHERE silo = \$1/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === "BI" ? [{ id: FORM, silo: "BI", name: "Quote", fields: [], button_label: "Send", thank_you: "Thanks!", tag: null, active: true, submissions: 0, created_at: "2026-10-01T00:00:00Z" }] : [] })],
    ]));
    submitKitLead.mockResolvedValue({ contactId: "c1", created: true });
  });

  it("serves the script for the key's silo with Boreal's consent wording and no pre-ticked box", async () => {
    const r = await request(app).get(`/api/kit/${KEY}/kit.js`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/javascript/);
    expect(r.text).toContain(FORM);
    expect(r.text).toContain(kitConsentText("Boreal Insurance"));
    expect(r.text).not.toContain("innerHTML");
    expect(r.text).not.toMatch(/checked\s*[:=]\s*true|"checked"/);
    expect((await request(app).get(`/api/kit/${"0".repeat(24)}/kit.js`)).status).toBe(404);
  });

  it("refuses a page that is not on the listed websites, and turns a good submission into a lead in the kit's silo", async () => {
    const body = JSON.stringify({ fields: { full_name: "Pat Lee", email: "pat@example.ca" }, consent: true });
    const bad = await request(app).post(`/api/kit/${KEY}/forms/${FORM}`).set("Origin", "https://evil.example.com").set("Content-Type", "text/plain").send(body);
    expect(bad.status).toBe(403);
    expect(submitKitLead).not.toHaveBeenCalled();
    const ok = await request(app).post(`/api/kit/${KEY}/forms/${FORM}`).set("Origin", "https://partner.example.ca").set("Content-Type", "text/plain").send(body);
    expect(ok.status).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBe("https://partner.example.ca");
    expect(ok.body).toMatchObject({ ok: true, message: "Thanks!" });
    expect(submitKitLead.mock.calls[0][1]).toBe("BI");
    expect(submitKitLead.mock.calls[0][3]).toMatchObject({ consent: true, values: { full_name: "Pat Lee", email: "pat@example.ca" } });
    const trap = await request(app).post(`/api/kit/${KEY}/forms/${FORM}`).set("Origin", "https://partner.example.ca").set("Content-Type", "text/plain").send(JSON.stringify({ fields: { email: "bot@example.ca" }, company_website: "x" }));
    expect(trap.status).toBe(200);
    expect(submitKitLead).toHaveBeenCalledTimes(1);
  });

  it("keeps chat and tracking off until switched on", async () => {
    const chat = await request(app).post(`/api/kit/${KEY}/chat`).set("Origin", "https://partner.example.ca").set("Content-Type", "text/plain").send(JSON.stringify({ message: "hi" }));
    expect(chat.status).toBe(404);
    const track = await request(app).post(`/api/kit/${KEY}/track`).set("Origin", "https://partner.example.ca").set("Content-Type", "text/plain").send(JSON.stringify({ sessionId: "abcdef12" }));
    expect(track.body).toMatchObject({ skipped: "tracking_off" });
    expect(callsMatching(queryMock, /INSERT INTO visitor_sessions/)).toHaveLength(0);
  });

  it("lets only Admins and Marketing users manage the silo's kit, and checks website addresses", async () => {
    expect((await request(app).get("/api/website-kit").set("Authorization", bearer("Staff"))).status).toBe(403);
    const r = await request(app).get("/api/website-kit").set("Authorization", bearer("Admin")).set("X-Silo", "BI");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ silo: "BI", brand: "Boreal Insurance" });
    expect(r.body.snippet.script).toBe(`<script src="https://server.boreal.financial/api/kit/${KEY}/kit.js" async></script>`);
    expect(r.body.snippet.forms[0].html).toBe(`<div data-boreal-form="${FORM}"></div>`);
    const bad = await request(app).put("/api/website-kit/settings").set("Authorization", bearer("Admin")).set("X-Silo", "BI").send({ allowed_origins: ["ftp://nope"] });
    expect(bad.status).toBe(400);
    const good = await request(app).put("/api/website-kit/settings").set("Authorization", bearer("Marketing", { silo: "BI" })).send({ allowed_origins: ["www.partner.example.ca/page"], chat_enabled: true });
    expect(good.status).toBe(200);
    const write = callsMatching(queryMock, /INSERT INTO boreal_settings/).find((c) => (c[1] as unknown[])[0] === "website_kit:BI")!;
    expect(JSON.parse(String((write[1] as unknown[])[1]))).toMatchObject({ key: KEY, allowed_origins: ["https://www.partner.example.ca"], chat_enabled: true });
  });

  it("validates submissions and website addresses", () => {
    const form = { id: FORM, silo: "BF", name: "Q", fields: normalizeFields([{ key: "full_name", required: true }, { key: "phone" }]), button_label: "Send", thank_you: "", tag: null, active: true, submissions: 0, created_at: "" } as KitForm;
    expect(form.fields.find((f) => f.key === "phone")!.required).toBe(true); // a lead must be reachable
    expect(parseSubmission(form, { fields: { full_name: "A", phone: "12" } })).toMatchObject({ ok: false, field: "phone" });
    expect(parseSubmission(form, { fields: { full_name: "A", phone: "403 555 0100" }, consent: "yes" })).toMatchObject({ ok: true, value: { consent: false } });
    expect(normalizeOrigin("http://example.ca")).toBeNull();
    expect(normalizeOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(originAllowed({ allowed_origins: ["https://a.example.ca"] }, undefined)).toBe(false);
  });

  it("the script builds the consent box unticked and only tracks after consent", () => {
    const js = kitScript({ base: "https://s", key: KEY, brand: "Boreal Financial", color: "red", consentText: "I agree", assistant: "Maya", chat: true, tracking: true, banner: true, forms: [] });
    expect(js).toContain('"color":"#0b3a6e"'); // an unsafe colour falls back to Boreal blue
    expect(js).toContain('consent !== "granted"');
  });
});

describe("the custom-role permission matrix", () => {
  it("maps the new routes to areas", () => {
    expect(requiredPermission("POST", "/lead-scores/lookup")).toEqual({ area: "contacts", action: "view" });
    expect(requiredPermission("GET", "/lead-scores/top")).toEqual({ area: "contacts", action: "view" });
    expect(requiredPermission("PUT", "/lead-scores/settings")).toEqual({ area: "marketing", action: "edit" });
    expect(requiredPermission("POST", "/website-kit/forms")).toEqual({ area: "marketing", action: "create" });
    expect(requiredPermission("GET", "/marketing/campaign-report")).toEqual({ area: "marketing", action: "view" });
    expect(requiredPermission("POST", "/kit/abc/forms/1")).toBeNull(); // public
  });
});
