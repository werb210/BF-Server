// BF_SERVER_v845_PUSH_DEDUPE - one event, one alert per device.
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyAllStaff } from "../notifyAllStaff.js";
import { __setStaffPushProvider, sendStaffAlert } from "../staffAlerts.js";
import { configureWatchPushProvider, sendWatchNotification } from "../../../watch/notifications.js";

const usersPool = () => ({ query: vi.fn(async (sql: string) => String(sql).includes("FROM users")
  ? { rows: [{ id: "u1", phone_number: null, email: null }] } : { rows: [] }) }) as any;
const ctx = {
  skipSms: true, notificationType: "sms_inbound", title: "New SMS from Jane", body: "Jane: hi",
  watch: { category: "MESSAGE" as const, eventType: "client_message" as const, title: "New client message", body: "New client message" },
  staffAlert: { category: "SMS" as const, type: "sms" as const, title: "Jane", body: "hi" },
};

afterEach(() => { __setStaffPushProvider(null); configureWatchPushProvider(null); });

describe("notifyAllStaff: the dialler alert is the one the watch shows", () => {
  it("skips the Watch app push when the iPhone dialler alert reached a device", async () => {
    const sendWatchNotification = vi.fn(async () => 1);
    const sendStaffAlert = vi.fn(async () => 1);
    await notifyAllStaff({ pool: usersPool(), ...ctx }, { pushToUser: vi.fn(), sendWatchNotification, sendStaffAlert } as any);
    expect(sendStaffAlert).toHaveBeenCalledTimes(1);
    expect(sendWatchNotification).not.toHaveBeenCalled();
  });

  it("still sends the Watch push when no dialler device got the alert", async () => {
    const sendWatchNotification = vi.fn(async () => 1);
    const sendStaffAlert = vi.fn(async () => 0);
    await notifyAllStaff({ pool: usersPool(), ...ctx }, { pushToUser: vi.fn(), sendWatchNotification, sendStaffAlert } as any);
    expect(sendWatchNotification).toHaveBeenCalledTimes(1);
  });

  it("still sends the Watch push when the dialler alert throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sendWatchNotification = vi.fn(async () => 1);
    const sendStaffAlert = vi.fn(async () => { throw new Error("apns down"); });
    await notifyAllStaff({ pool: usersPool(), ...ctx }, { pushToUser: vi.fn(), sendWatchNotification, sendStaffAlert } as any);
    expect(sendWatchNotification).toHaveBeenCalledTimes(1);
  });
});

describe("duplicate registrations reach a device once", () => {
  it("Watch: rows sharing a token send once", async () => {
    const send = vi.fn(async () => undefined);
    configureWatchPushProvider({ send });
    const query = vi.fn(async () => ({ rows: [
      { id: "d1", device_id: "d1", token_ciphertext: "c1", environment: "production" },
      { id: "d2", device_id: "d2", token_ciphertext: "c2", environment: "production" },
      { id: "d3", device_id: "d3", token_ciphertext: "c3", environment: "production" },
    ] }));
    const decrypt = (c: string) => (c === "c3" ? "tok-B" : "tok-A");
    const sent = await sendWatchNotification({ staffUserId: "u1", category: "MESSAGE", eventType: "client_message", title: "t", body: "b" },
      { query: query as any, decrypt });
    expect(sent).toBe(2);
    expect(send.mock.calls.map((c: any[]) => c[0].token)).toEqual(["tok-A", "tok-B"]);
  });

  it("dialler: rows sharing a token send once", async () => {
    const send = vi.fn(async () => undefined);
    __setStaffPushProvider({ send });
    const tok = "a".repeat(64);
    const query = vi.fn(async () => ({ rows: [
      { id: "t1", token: tok, environment: "production", app: "dialer-ios" },
      { id: "t2", token: tok, environment: "production", app: "dialer-ios" },
    ] }));
    const sent = await sendStaffAlert({ userId: "u1", category: "SMS", type: "sms", title: "Jane", body: "hi" }, { query: query as any });
    expect(sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
