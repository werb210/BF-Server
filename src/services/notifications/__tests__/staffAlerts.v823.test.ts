// BF_SERVER_v823_PUSH - staff alerts reach the iPad portal app (portal-ios, its own APNs topic, a portal path to
// open) as well as the iPhone dialler, and task reminders are a staff alert category of their own.
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setStaffPushProvider, portalAlertUrl, sendStaffAlert, STAFF_PUSH_APPS } from "../staffAlerts.js";

const USER = "11111111-2222-4333-8444-555555555555";

afterEach(() => __setStaffPushProvider(null));

function db(rows: Array<{ id: string; token: string; environment: string; app: string }>) {
  return vi.fn(async (sql: string) => (/FROM staff_push_tokens/.test(sql) ? { rows } : { rows: [], rowCount: 1 }));
}

describe("v823 iPad portal alerts", () => {
  it("accepts the portal app", () => {
    expect([...STAFF_PUSH_APPS]).toEqual(["dialer-ios", "portal-ios"]);
  });

  it("sends each device through its own app's sender; only the iPad gets the page to open", async () => {
    const dialer = { send: vi.fn(async () => undefined) };
    const portal = { send: vi.fn(async () => undefined) };
    __setStaffPushProvider(dialer, portal);
    const query = db([
      { id: "d1", token: "a".repeat(64), environment: "production", app: "dialer-ios" },
      { id: "p1", token: "b".repeat(64), environment: "production", app: "portal-ios" },
    ]);
    const sent = await sendStaffAlert({ userId: USER, title: "Missed call", body: "Jane", category: "MISSED_CALL", type: "missed_call",
      data: { url: "/communications" } }, { query });
    expect(sent).toBe(2);
    expect(dialer.send).toHaveBeenCalledTimes(1);
    expect(portal.send).toHaveBeenCalledTimes(1);
    expect((dialer.send.mock.calls[0] as any[])[1].url).toBeUndefined();
    expect((portal.send.mock.calls[0] as any[])[1].url).toBe("/communications");
    expect((query.mock.calls[0] as any[])[1]).toEqual([USER, ["dialer-ios", "portal-ios"]]);
  });

  it("only passes an in-portal path", () => {
    expect(portalAlertUrl("/crm/contacts/abc")).toBe("/crm/contacts/abc");
    expect(portalAlertUrl("https://evil.example")).toBeUndefined();
    expect(portalAlertUrl("//evil.example")).toBeUndefined();
    expect(portalAlertUrl("/a/../b")).toBeUndefined();
    expect(portalAlertUrl(null)).toBeUndefined();
  });

  it("sends task reminders as their own category", async () => {
    const dialer = { send: vi.fn(async () => undefined) };
    __setStaffPushProvider(dialer, null);
    const sent = await sendStaffAlert({ userId: USER, title: "Task reminder", body: "Call Jane", category: "TASK", type: "task_due",
      data: { url: "/tasks" } }, { query: db([{ id: "d1", token: "a".repeat(64), environment: "production", app: "dialer-ios" }]) });
    expect(sent).toBe(1);
    const payload = (dialer.send.mock.calls[0] as any[])[1];
    expect(payload.type).toBe("task_due");
    expect(payload.aps.category).toBe("TASK");
  });
});
