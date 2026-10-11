// BF_SERVER_v784_GRAPH_CLIENT_STATE - Graph notifications must carry the exact
// clientState stored for their subscription.
import { describe, it, expect, vi, beforeEach } from "vitest";

const createNotification = vi.fn(async () => undefined);
const graphFetch = vi.fn();

vi.mock("../db.js", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../modules/notifications/notifications.repo.js", () => ({
  createNotification: (...a: unknown[]) => (createNotification as any)(...a),
  isNonPersonUser: () => false,
}));
vi.mock("../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: vi.fn(async () => undefined) }));
vi.mock("../modules/o365/graphClient.js", () => ({ getGraphForUser: vi.fn(async () => ({ fetch: graphFetch })) }));

import { handleGraphNotifications, clientStateMatches, ensureMailSubscription } from "../modules/o365/mailSubscriptions.js";

const STORED = "a".repeat(48);
function poolFor(stored: string | null) {
  return {
    query: vi.fn(async (sql: string) => {
      if (/FROM graph_mail_subscriptions WHERE subscription_id/i.test(sql)) {
        return { rows: [{ user_id: "user-1", client_state: stored, resource: "me/mailFolders('inbox')/messages" }] };
      }
      return { rows: [] };
    }),
  } as any;
}

beforeEach(() => { createNotification.mockClear(); graphFetch.mockReset(); });

describe("clientStateMatches", () => {
  it("accepts only an exact match", () => {
    expect(clientStateMatches(STORED, STORED)).toBe(true);
    expect(clientStateMatches(STORED + "b", STORED)).toBe(false);
    expect(clientStateMatches("b" + STORED.slice(1), STORED)).toBe(false);
    expect(clientStateMatches(undefined, STORED)).toBe(false);
    expect(clientStateMatches("", STORED)).toBe(false);
    expect(clientStateMatches(STORED, null)).toBe(false);
    expect(clientStateMatches(STORED, "")).toBe(false);
  });
});

describe("handleGraphNotifications", () => {
  it("processes a notification whose clientState matches", async () => {
    await handleGraphNotifications(poolFor(STORED), [{ subscriptionId: "sub-1", clientState: STORED, resourceData: { id: "m1" } }]);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });
  it("ignores a notification with no clientState", async () => {
    await handleGraphNotifications(poolFor(STORED), [{ subscriptionId: "sub-1", resourceData: { id: "m1" } }]);
    expect(createNotification).not.toHaveBeenCalled();
  });
  it("ignores a notification whose clientState differs", async () => {
    await handleGraphNotifications(poolFor(STORED), [{ subscriptionId: "sub-1", clientState: "forged", resourceData: { id: "m1" } }]);
    expect(createNotification).not.toHaveBeenCalled();
  });
  it("ignores a notification when the stored subscription has no clientState", async () => {
    await handleGraphNotifications(poolFor(null), [{ subscriptionId: "sub-1", clientState: STORED, resourceData: { id: "m1" } }]);
    expect(createNotification).not.toHaveBeenCalled();
  });
});

describe("ensureMailSubscription", () => {
  it("creates the subscription with a clientState and stores the same value", async () => {
    graphFetch.mockResolvedValue({ ok: true, status: 201, text: async () => JSON.stringify({ id: "sub-new", expirationDateTime: new Date().toISOString() }) });
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = { query: vi.fn(async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return { rows: [] }; }) } as any;
    await ensureMailSubscription(pool, "user-1");
    const body = JSON.parse(graphFetch.mock.calls[0][1].body);
    expect(typeof body.clientState).toBe("string");
    expect(body.clientState.length).toBeGreaterThan(16);
    const insert = calls.find((c) => /INSERT INTO graph_mail_subscriptions/i.test(c.sql));
    expect(insert?.params?.[3]).toBe(body.clientState);
  });
});
