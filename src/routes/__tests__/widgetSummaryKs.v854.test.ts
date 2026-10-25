// BF_SERVER_v854_KS_WIDGETS - the staff widget on the Keystone (KS) silo: Keystone figures for staff allowed into the
// Keystone CRM, an empty summary with the reason for everyone else, and BF / BI / SLF answers unchanged.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import widgetSummaryRoutes from "../widgetSummary.js";
import { answerBySql, callsMatching, sqlText } from "../../__tests__/helpers/answerBySql.js";
import { KS_WIDGET_NO_ACCESS, isKeystoneWidgetCall, requestedWidgetSilo } from "../../modules/ks/ksWidget.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock };
});

const USER_ID = "00000000-0000-4000-8000-0000000008a4";
const PROFILE = /FROM users WHERE id = \$1/;
type Profile = { role: string; silo: string; silos: string[] };
let profile: Profile = { role: "Admin", silo: "BF", silos: ["BF"] };
let supportTable = false;

const token = () => jwt.sign({ sub: USER_ID, id: USER_ID, role: profile.role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));

function answers() {
  return answerBySql([
    [PROFILE, () => ({ rows: [{ id: USER_ID, ...profile }] })],
    [/WITH ks_cards AS/, { rows: [{ open_deals: "9", paying: "4", demos_no_follow_up: "2" }] }],
    [/AS overdue/, { rows: [{ due: "5", overdue: "3" }] }],
    [/FROM communications_messages m/, { rows: [{ count: "6" }] }],
    [/ORDER BY t\.due_at ASC/, { rows: [{ id: "t-1", title: "Call Ada about the demo", type: "CALL", due_at: "2026-10-24T15:00:00.000Z", contact_name: "Ada Lovelace" }] }],
    [/FROM booking_events b/, { rows: [{ id: "b-1", title: "Keystone demo", scheduled_at: "2026-10-25T16:00:00.000Z" }] }],
    [/to_regclass\('public\.ks_support_tickets'\)/, () => ({ rows: [{ present: supportTable }] })],
    [/WHERE status IN \('new', 'open', 'waiting'\)/, { rows: [{ count: "7" }] }],
    // BF figures (the existing widget queries)
    [/FROM tasks t/, { rows: [{ count: "1" }] }],
    [/AS commission/, { rows: [{ commission: "100" }] }],
    [/FROM applications a/, { rows: [{ count: "2" }] }],
  ]);
}

function get(silo: string, how: "header" | "query" = "header") {
  const app = express();
  app.use("/api/widget", widgetSummaryRoutes);
  const r = how === "header"
    ? request(app).get("/api/widget/summary").set("X-Silo", silo)
    : request(app).get(`/api/widget/summary?silo=${silo}`);
  return r.set("Authorization", `Bearer ${token()}`);
}
const dataCalls = () => queryMock.mock.calls.filter(([sql]) => !PROFILE.test(sqlText(sql)));

beforeEach(() => {
  profile = { role: "Admin", silo: "BF", silos: ["BF"] };
  supportTable = false;
  queryMock.mockReset();
  queryMock.mockImplementation(answers());
});

describe("Keystone figures", () => {
  it("gives an Admin the Keystone tiles: open deals, KS tasks and messages, paying licensees", async () => {
    const res = await get("KS");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: "keystone",
      silo: "KS",
      available: true,
      reason: null,
      pipelineCount: 9,
      tasksDueToday: 5,
      tasksOverdue: 3,
      unreadMessages: 6,
      payingLicensees: 4,
      demosNeedFollowUp: 2,
      commissionEarned: 0,
      currency: "CAD",
    });
    expect(new Date(res.body.asOf).toISOString()).toBe(res.body.asOf);
  });

  it("names the next KS task and the next KS booking", async () => {
    const res = await get("KS");
    expect(res.body.nextTask).toEqual({ id: "t-1", title: "Call Ada about the demo", type: "CALL", dueAt: "2026-10-24T15:00:00.000Z", contactName: "Ada Lovelace" });
    expect(res.body.nextMeeting).toEqual({ id: "b-1", title: "Keystone demo", start: "2026-10-25T16:00:00.000Z" });
  });

  it("works from ?silo=KS as well as the header", async () => {
    const res = await get("ks", "query");
    expect(res.body).toMatchObject({ kind: "keystone", silo: "KS", pipelineCount: 9 });
  });

  it("only reads Keystone rows, and never the BF lender figures", async () => {
    await get("KS");
    for (const [sql] of dataCalls()) {
      const text = sqlText(sql);
      if (/to_regclass/.test(text)) continue;
      expect(text).toMatch(/silo = 'KS'/);
      expect(text).not.toMatch(/FROM applications/);
      expect(text).not.toMatch(/AS commission/);
    }
  });

  it("counts open deals as every card not Paying or Lost, the same cards as the pipeline board", async () => {
    await get("KS");
    const sql = sqlText(callsMatching(queryMock, /WITH ks_cards AS/)[0]![0]);
    expect(sql).toContain("k.stage NOT IN ('paying', 'lost')");
    expect(sql).toContain("k.stage = 'paying'");
    expect(sql).toContain("c.company_id IS NULL AND c.merged_into_id IS NULL");
    expect(sql).toContain("k.stage = 'demo_finished' AND NOT EXISTS");
  });

  it("counts the caller's (or unclaimed) KS tasks with the Tasks page's overdue rule", async () => {
    await get("KS");
    const [call] = callsMatching(queryMock, /AS overdue/);
    expect(sqlText(call![0])).toContain("t.due_at < now() AND t.due_at::date < now()::date");
    expect(sqlText(call![0])).toContain("t.assignee_user_id = $1 OR t.assignee_user_id IS NULL");
    expect(call![1]).toEqual([USER_ID]);
  });

  it("leaves support tickets out (null) until the support table exists", async () => {
    const res = await get("KS");
    expect(res.body.openSupportTickets).toBeNull();
    expect(callsMatching(queryMock, /WHERE status IN \('new', 'open', 'waiting'\)/)).toHaveLength(0);
  });

  it("counts open support tickets once the table is there", async () => {
    supportTable = true;
    const res = await get("KS");
    expect(res.body.openSupportTickets).toBe(7);
  });

  it("still answers, without the ticket tile, when the ticket count fails (and logs it)", async () => {
    supportTable = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    queryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      if (/WHERE status IN/.test(sqlText(sql))) throw new Error("boom");
      return answers()(sql, params);
    });
    const res = await get("KS");
    expect(res.status).toBe(200);
    expect(res.body.openSupportTickets).toBeNull();
    expect(res.body.pipelineCount).toBe(9);
    expect(warn).toHaveBeenCalledWith("[ks-widget] support ticket count failed", "boom");
    warn.mockRestore();
  });
});

describe("Keystone access", () => {
  it("gives staff whose silo access includes KS the figures", async () => {
    profile = { role: "Staff", silo: "BF", silos: ["BF", "KS"] };
    const res = await get("KS");
    expect(res.body).toMatchObject({ kind: "keystone", available: true, pipelineCount: 9 });
  });

  it("gives staff without KS an empty Keystone summary with the reason - not their BF numbers", async () => {
    profile = { role: "Staff", silo: "BF", silos: ["BF", "BI"] };
    const res = await get("KS");
    expect(res.status).toBe(200); // not 401/403: the app's background refresh signs out on those
    expect(res.body).toMatchObject({
      kind: "keystone",
      silo: "KS",
      available: false,
      reason: KS_WIDGET_NO_ACCESS,
      pipelineCount: 0,
      tasksDueToday: 0,
      unreadMessages: 0,
      payingLicensees: 0,
      nextTask: null,
      nextMeeting: null,
    });
    expect(dataCalls()).toHaveLength(0);
  });

  it("treats a single-silo staff member the same way", async () => {
    profile = { role: "Staff", silo: "BF", silos: ["BF"] };
    const res = await get("KS");
    expect(res.body).toMatchObject({ available: false });
    expect(dataCalls()).toHaveLength(0);
  });
});

describe("the other silos are unchanged", () => {
  it("answers BF with the lender figures and no Keystone fields", async () => {
    const res = await get("BF");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ silo: "BF", pipelineCount: 2, tasksDueToday: 1, commissionEarned: 100 });
    expect(res.body).not.toHaveProperty("kind");
    expect(callsMatching(queryMock, /ks_cards/)).toHaveLength(0);
  });
});

describe("which calls are Keystone", () => {
  it("reads the header first, then ?silo=", () => {
    expect(requestedWidgetSilo({ headers: { "x-silo": " ks " }, query: { silo: "BF" } })).toBe("KS");
    expect(requestedWidgetSilo({ headers: {}, query: { silo: "ks" } })).toBe("KS");
    expect(requestedWidgetSilo({ headers: {}, query: {} })).toBeNull();
  });

  it("is Keystone when asked for by name or when the caller's own silo is KS", () => {
    expect(isKeystoneWidgetCall("KS", "BF")).toBe(true);
    expect(isKeystoneWidgetCall(null, "KS")).toBe(true);
    expect(isKeystoneWidgetCall("BF", "BF")).toBe(false);
    expect(isKeystoneWidgetCall("BI", "BI")).toBe(false);
  });
});
