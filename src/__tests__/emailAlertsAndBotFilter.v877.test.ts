// BF_SERVER_v877 - one push per burst of inbound email, never two for the same
// message; client-app analytics from scripts and bots are not stored.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const h = vi.hoisted(() => ({
  inserts: [] as unknown[][],
  notifications: [] as Array<{ id: string; userId: string; count: number; messageIds: string[]; read: boolean; createdAt: number }>,
  created: [] as unknown[],
}));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const query = async (sql: string, params: unknown[] = []) => {
    if (/insert into analytics_events/i.test(sql)) { h.inserts.push(params); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  };
  return { ...real, pool: { query }, runQuery: query, dbQuery: query };
});
vi.mock("../modules/notifications/notifications.repo.js", () => ({
  isNonPersonUser: () => false,
  createNotification: async (p: any) => {
    h.created.push(p);
    h.notifications.push({ id: p.notificationId, userId: p.userId, count: 1, messageIds: p.metadata?.messageIds ?? [], read: false, createdAt: Date.now() });
    return p;
  },
}));
vi.mock("../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: vi.fn(async () => undefined) }));
vi.mock("../modules/o365/graphClient.js", () => ({ getGraphForUser: vi.fn(async () => null) }));

import { handleGraphNotifications, __resetEmailAlertStateForTests } from "../modules/o365/mailSubscriptions.js";
import { buildAnalyticsRouter, isScriptOrBotUserAgent } from "../routes/analytics.js";

const STATE = "s".repeat(48);
// A fake notifications table that answers by SQL content.
const fakePool = {
  query: vi.fn(async (sql: string, params: any[] = []) => {
    if (/FROM graph_mail_subscriptions WHERE subscription_id/i.test(sql)) {
      return { rows: [{ user_id: "todd", client_state: STATE, resource: "me/mailFolders('inbox')/messages" }] };
    }
    if (/SELECT 1 FROM notifications/i.test(sql)) {
      const [userId, messageId] = params;
      return { rows: h.notifications.filter((n) => n.userId === userId && n.messageIds.includes(messageId)).map(() => ({ "?column?": 1 })) };
    }
    if (/UPDATE notifications/i.test(sql)) {
      const [userId, messageId, minutes] = params;
      const open = h.notifications
        .filter((n) => n.userId === userId && !n.read && Date.now() - n.createdAt < minutes * 60_000)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!open) return { rows: [] };
      open.count += 1;
      if (messageId) open.messageIds.push(messageId);
      return { rows: [{ id: open.id, count: open.count }] };
    }
    return { rows: [] };
  }),
} as any;

const mail = (id: string) => ({ subscriptionId: "sub-1", clientState: STATE, resourceData: { id } });

beforeEach(() => {
  h.inserts.length = 0; h.notifications.length = 0; h.created.length = 0;
  __resetEmailAlertStateForTests();
});

describe("v877 inbound email alerts", () => {
  it("a burst of emails raises one notification (one push) that counts them", async () => {
    for (let i = 0; i < 5; i++) await handleGraphNotifications(fakePool, [mail(`m${i}`)]);
    expect(h.created).toHaveLength(1);
    expect(h.notifications[0]!.count).toBe(5);
  });

  it("the same message delivered twice at once notifies once", async () => {
    await Promise.all([handleGraphNotifications(fakePool, [mail("dup")]), handleGraphNotifications(fakePool, [mail("dup")])]);
    expect(h.created).toHaveLength(1);
    expect(h.notifications[0]!.count).toBe(1);
  });

  it("once the alert is read, the next email pushes again", async () => {
    await handleGraphNotifications(fakePool, [mail("a")]);
    h.notifications[0]!.read = true;
    await handleGraphNotifications(fakePool, [mail("b")]);
    expect(h.created).toHaveLength(2);
  });

  it("an alert older than the window is not reused", async () => {
    await handleGraphNotifications(fakePool, [mail("a")]);
    h.notifications[0]!.createdAt -= 16 * 60_000;
    await handleGraphNotifications(fakePool, [mail("b")]);
    expect(h.created).toHaveLength(2);
  });
});

describe("v877 analytics ignores scripts and bots", () => {
  const app = express();
  app.use("/api/analytics", buildAnalyticsRouter());
  const post = (ua?: string) => {
    const r = request(app).post("/api/analytics");
    if (ua !== undefined) r.set("User-Agent", ua);
    return r.send({ event_name: "client_step_viewed", payload: { step: 1 } });
  };

  it("the 'node' user agent seen overnight is answered but not stored", async () => {
    const r = await post("node");
    expect(r.status).toBe(202);
    expect(r.body.stored).toBe(false);
    expect(h.inserts).toHaveLength(0);
  });

  it("no user agent, curl, python and crawlers are not stored", async () => {
    for (const ua of ["", "curl/8.4.0", "python-requests/2.31", "Mozilla/5.0 (compatible; Googlebot/2.1)", "Mozilla/5.0 HeadlessChrome/120"]) await post(ua);
    expect(h.inserts).toHaveLength(0);
  });

  it("a phone app web view and a desktop browser are stored", async () => {
    await post("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148");
    await post("Mozilla/5.0 (Linux; Android 15; Pixel 9; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36");
    await post("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15");
    expect(h.inserts).toHaveLength(3);
  });

  it("isScriptOrBotUserAgent", () => {
    expect(isScriptOrBotUserAgent("node")).toBe(true);
    expect(isScriptOrBotUserAgent(undefined)).toBe(true);
    expect(isScriptOrBotUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36")).toBe(false);
  });
});
