// BF_SERVER_v811_MOBILE_APPS_REPORT - Marketing > Mobile apps: usage by iPhone / iPad / Android / web from the client
// apps' anonymous "app_*" events, plus notification and quick sign-in set-ups. Store downloads are marked not connected.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), role: "Marketing" }));
vi.mock("../middleware/auth.js", () => ({ requireAuth: (req: any, _res: any, next: any) => { req.user = { id: "u1", role: h.role }; next(); } }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  return { ...real, pool: { query: q }, dbQuery: q, runQuery: q };
});

import reportRouter from "../routes/mobileAppsReport.js";
import { buildAnalyticsRouter } from "../routes/analytics.js";
import { clampDays } from "../modules/reporting/mobileApps.js";

const app = express();
app.use(express.json());
app.use("/api/reports", reportRouter);
app.use("/api/analytics", buildAnalyticsRouter());

beforeEach(() => {
  h.role = "Marketing";
  h.query.mockReset().mockImplementation(answerBySql([
    [/substring\(e\.event from 5\) AS event/, { rows: [{ device: "iphone", event: "open", n: 12, users: 5 }, { device: "android", event: "sign_in", n: 3, users: 2 }, { device: "pager", event: "open", n: 1, users: 1 }] }],
    [/AS d1/, { rows: [{ device: "iphone", d1: 2, d7: 4, period: 5 }] }],
    [/AS day/, { rows: [{ day: "2026-10-15", device: "iphone", users: 2 }] }],
    [/AS method/, { rows: [{ method: "biometric", device: "android", n: 3 }] }],
    [/AS version/, { rows: [{ device: "iphone", version: "1.0 (1)", users: 5, last_seen: "2026-10-15" }] }],
    [/FROM client_push_tokens/, { rows: [{ platform: "ios", users: 4 }] }],
    [/AS biometric/, { rows: [{ biometric: 3, passkey: 1 }] }],
    [/insert into analytics_events/i, { rows: [] }],
  ]));
});

describe("v811 GET /api/reports/mobile-apps", () => {
  it("returns usage by device, sign-in methods, versions, notifications and quick sign-in", async () => {
    const r = await request(app).get("/api/reports/mobile-apps").query({ days: 7 });
    expect(r.status).toBe(200);
    expect(r.body.days).toBe(7);
    expect(r.body.events.iphone.open).toEqual({ count: 12, users: 5 });
    expect(r.body.events.android.sign_in).toEqual({ count: 3, users: 2 });
    expect(r.body.events.ipad.open).toEqual({ count: 0, users: 0 });
    expect(r.body.events.pager).toBeUndefined();
    expect(r.body.active.iphone).toEqual({ d1: 2, d7: 4, period: 5 });
    expect(r.body.daily).toEqual([{ day: "2026-10-15", device: "iphone", users: 2 }]);
    expect(r.body.signInMethods).toEqual([{ method: "biometric", device: "android", count: 3 }]);
    expect(r.body.versions[0]).toEqual({ device: "iphone", version: "1.0 (1)", users: 5, lastSeen: "2026-10-15" });
    expect(r.body.notificationsOn).toEqual([{ platform: "ios", users: 4 }]);
    expect(r.body.quickSignIn).toEqual({ biometric: 3, passkey: 1 });
    expect(r.body.stores.apple.connected).toBe(false);
    expect(r.body.stores.google.connected).toBe(false);
    expect((callsMatching(h.query, /AS d1/)[0]![1] as unknown[])[0]).toBe(7);
  });
  it("is for staff only", async () => {
    h.role = "Lender";
    expect((await request(app).get("/api/reports/mobile-apps")).status).toBe(403);
  });
  it("keeps the period between 1 and 365 days", () => {
    expect(clampDays(undefined)).toBe(30);
    expect(clampDays("0")).toBe(30);
    expect(clampDays("9999")).toBe(365);
  });
});

describe("v811 analytics collector", () => {
  it("stores the client app's usage events", async () => {
    const r = await request(app).post("/api/analytics").send({ event: "app_open", properties: { platform: "ios", device: "iphone", version: "1.0 (1)", install_id: "abc-123" } });
    expect(r.status).toBe(202);
    const row = callsMatching(h.query, /insert into analytics_events/i)[0]![1] as unknown[];
    expect(row[0]).toBe("app_open");
    expect(JSON.parse(String(row[1])).properties).toEqual({ platform: "ios", device: "iphone", version: "1.0 (1)", install_id: "abc-123" });
  });
  it("also accepts the { event_name, payload } shape the web app's trackEvent sends", async () => {
    const r = await request(app).post("/api/analytics").send({ event_name: "client_step_viewed", payload: { step: 6, session_id: "s1", email: "a@b.co" } });
    expect(r.status).toBe(202);
    const row = callsMatching(h.query, /insert into analytics_events/i)[0]![1] as unknown[];
    expect(row[0]).toBe("client_step_viewed");
    const meta = JSON.parse(String(row[1]));
    expect(meta.session_id).toBe("s1");
    expect(meta.properties.step).toBe(6);
    expect(meta.properties.email).toBeUndefined();
  });
});
