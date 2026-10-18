// BF_SERVER_v820_WATCH_CALLS - staff iPhone dialler alerts: token registration, APNs payload, delivery, fan-out.
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";
import { mountRouter, staffToken, STAFF_USER_ID } from "../../../__tests__/helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({ query: vi.fn(), notify: vi.fn() }));
vi.mock("../../../db.js", async () => ({ ...(await vi.importActual<any>("../../../db.js")), pool: { query: h.query }, dbQuery: h.query, runQuery: h.query }));

import {
  __setStaffPushProvider, buildStaffAlertPayload, initializeStaffPushProvider, sendStaffAlert, staffApnsCredentials,
} from "../staffAlerts.js";
import { WatchApnsError } from "../../../watch/apnsProvider.js";
import { notifyAllStaff } from "../notifyAllStaff.js";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const CONTACT = "c0c0c0c0-0000-4000-8000-000000000002";
const APP_ID = "a0a0a0a0-0000-4000-8000-000000000003";

beforeEach(() => { h.query.mockReset(); h.query.mockImplementation(answerBySql([])); });
afterEach(() => { __setStaffPushProvider(null); vi.restoreAllMocks(); });

describe("POST/DELETE /api/staff/push-token", () => {
  async function app() {
    return mountRouter((await import("../../../routes/staffPushToken.js")).default, "/api/staff/push-token");
  }

  it("upserts the signed-in staff member's dialler token", async () => {
    h.query.mockImplementation(answerBySql([[/INSERT INTO staff_push_tokens/, { rows: [{ id: "t-1", environment: "sandbox", app: "dialer-ios" }] }]]));
    const res = await request(await app()).post("/api/staff/push-token").set("Authorization", `Bearer ${staffToken("Staff")}`)
      .send({ token: TOKEN_A.toUpperCase(), environment: "sandbox" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, registration: { id: "t-1", environment: "sandbox" } });
    const [sql, params] = callsMatching(h.query, /INSERT INTO staff_push_tokens/)[0]!;
    expect(String(sql)).toContain("ON CONFLICT (token) DO UPDATE");
    expect(params).toEqual([STAFF_USER_ID, TOKEN_A, "sandbox", "dialer-ios"]);
  });

  it("defaults to production and rejects bad tokens, environments and apps", async () => {
    const auth = { Authorization: `Bearer ${staffToken("Admin")}` };
    expect((await request(await app()).post("/api/staff/push-token").set(auth).send({ token: TOKEN_A })).status).toBe(200);
    expect((callsMatching(h.query, /INSERT INTO staff_push_tokens/)[0]![1] as unknown[])[2]).toBe("production");
    for (const body of [{ token: "abc" }, { token: "z".repeat(64) }, { token: "a".repeat(201) }, { token: TOKEN_A, environment: "dev" }, { token: TOKEN_A, app: "portal" }]) {
      expect((await request(await app()).post("/api/staff/push-token").set(auth).send(body)).status).toBe(400);
    }
  });

  it("requires a staff sign-in", async () => {
    expect((await request(await app()).post("/api/staff/push-token").send({ token: TOKEN_A })).status).toBe(401);
  });

  it("deletes only the caller's own token", async () => {
    h.query.mockImplementation(answerBySql([[/DELETE FROM staff_push_tokens/, { rows: [], rowCount: 1 }]]));
    const res = await request(await app()).delete("/api/staff/push-token").set("Authorization", `Bearer ${staffToken("Staff")}`).send({ token: TOKEN_A });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: 1 });
    expect(callsMatching(h.query, /DELETE FROM staff_push_tokens WHERE token = \$1 AND user_id::text = \$2/)[0]![1]).toEqual([TOKEN_A, STAFF_USER_ID]);
  });

  it("is registered at /api/staff/push-token ahead of the /staff router", async () => {
    const { API_ROUTE_MOUNTS, ROUTES } = await import("../../../routes/routeRegistry.js");
    const paths = API_ROUTE_MOUNTS.map((m) => m.path);
    expect(paths.indexOf("/staff/push-token")).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf("/staff/push-token")).toBeLessThan(paths.indexOf("/staff"));
    expect(ROUTES.filter((r) => r.path === "/api/staff/push-token").map((r) => r.method).sort()).toEqual(["DELETE", "POST"]);
  }, 60_000); // the registry imports every router
});

describe("staff alert APNs payload", () => {
  it("carries the alert, category, thread-id, type and allowlisted ids only", () => {
    const payload = buildStaffAlertPayload({
      title: "Message from Jane Client", body: "x".repeat(300), category: "CLIENT_MESSAGE", type: "client_message",
      data: { contactId: CONTACT, applicationId: APP_ID, phone: "+14035550144", threadKind: "messages", ssn: "nope" } as any,
    });
    expect(payload).toEqual({
      aps: { alert: { title: "Message from Jane Client", body: `${"x".repeat(119)}…` }, sound: "default", category: "CLIENT_MESSAGE", "thread-id": `client_message:${CONTACT}`,
        "interruption-level": "time-sensitive", "relevance-score": 0.7, "mutable-content": 1 }, // BF_SERVER_v821_DIALER, v822 CarPlay
      schema: 1, type: "client_message", contactId: CONTACT, applicationId: APP_ID, phone: "+14035550144", threadKind: "messages",
    });
  });

  it("drops ids that are not ids", () => {
    const payload = buildStaffAlertPayload({ title: "Missed call", body: "Unknown", category: "MISSED_CALL", type: "missed_call",
      data: { contactId: "not-a-uuid", phone: "4035550144", threadKind: "email" as any } });
    expect(payload).toEqual({ aps: { alert: { title: "Missed call", body: "Unknown" }, sound: "default", category: "MISSED_CALL", "thread-id": "missed_call:general",
      "interruption-level": "time-sensitive", "relevance-score": 0.9 }, schema: 1, type: "missed_call" }); // BF_SERVER_v821_DIALER
  });
});

describe("sendStaffAlert", () => {
  const input = { userId: STAFF_USER_ID, title: "Voicemail from Jane", body: "Call me back", category: "VOICEMAIL" as const, type: "voicemail" as const };
  const tokens = (rows: Array<{ id: string; token: string; environment: string }>) =>
    h.query.mockImplementation(answerBySql([[/FROM staff_push_tokens/, { rows }]]));

  it("sends nothing when no provider is configured", async () => {
    expect(await sendStaffAlert(input)).toBe(0);
    expect(h.query).not.toHaveBeenCalled();
  });

  it("delivers to every dialler token of the user on its own host", async () => {
    const send = vi.fn(async () => undefined);
    __setStaffPushProvider({ send });
    tokens([{ id: "t1", token: TOKEN_A, environment: "production" }, { id: "t2", token: TOKEN_B, environment: "sandbox" }]);
    expect(await sendStaffAlert(input)).toBe(2);
    expect(send.mock.calls.map((c: any[]) => [c[0].token, c[0].environment])).toEqual([[TOKEN_A, "production"], [TOKEN_B, "sandbox"]]);
    expect(callsMatching(h.query, /FROM staff_push_tokens/)[0]![1]).toEqual([STAFF_USER_ID]);
  });

  it("BadDeviceToken tries the other host once and remembers it", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new WatchApnsError(400, "BadDeviceToken", true))
      .mockResolvedValueOnce(undefined);
    __setStaffPushProvider({ send });
    tokens([{ id: "t1", token: TOKEN_A, environment: "production" }]);
    expect(await sendStaffAlert(input)).toBe(1);
    expect(send.mock.calls.map((c: any[]) => c[0].environment)).toEqual(["production", "sandbox"]);
    expect(callsMatching(h.query, /UPDATE staff_push_tokens SET environment=\$2/)[0]![1]).toEqual(["t1", "sandbox"]);
  });

  it("deletes an invalid token and never logs a token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn().mockRejectedValue(new WatchApnsError(410, "Unregistered", true));
    __setStaffPushProvider({ send });
    tokens([{ id: "t1", token: TOKEN_A, environment: "production" }]);
    expect(await sendStaffAlert(input)).toBe(0);
    expect(callsMatching(h.query, /DELETE FROM staff_push_tokens WHERE id::text=\$1/)[0]![1]).toEqual(["t1"]);
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("staff_push_failed");
    expect(logged).toContain("Unregistered");
    expect(logged).not.toContain(TOKEN_A);
  });

  it("a transient failure keeps the token and records the reason", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    __setStaffPushProvider({ send: vi.fn().mockRejectedValue(new WatchApnsError(500, "InternalServerError", false)) });
    tokens([{ id: "t1", token: TOKEN_A, environment: "production" }]);
    expect(await sendStaffAlert(input)).toBe(0);
    expect(callsMatching(h.query, /DELETE FROM staff_push_tokens/)).toHaveLength(0);
    expect(callsMatching(h.query, /SET last_error=\$2/)[0]![1]).toEqual(["t1", "InternalServerError"]);
  });

  it("STAFF_APNS_* wins, falls back to WATCH_APNS_*, bundle defaults to the dialler", () => {
    expect(staffApnsCredentials({ WATCH_APNS_TEAM_ID: "W1", WATCH_APNS_KEY_ID: "WK", WATCH_APNS_PRIVATE_KEY: "a\\nb", STAFF_APNS_KEY_ID: "SK" } as any))
      .toEqual({ teamId: "W1", keyId: "SK", privateKey: "a\nb", bundleId: "com.borealfinancial.dialer" });
    expect(staffApnsCredentials({ STAFF_APNS_BUNDLE_ID: "com.example.other" } as any).bundleId).toBe("com.example.other");
    expect(initializeStaffPushProvider({ NODE_ENV: "test" } as any)).toBe(false);
  });
});

describe("notifyAllStaff fans the alert out to the iPhone dialler", () => {
  const deps = () => ({ pushToUser: vi.fn(), sendSMS: vi.fn(async () => ({ success: true })), sendWatchNotification: vi.fn(async () => 1), sendStaffAlert: vi.fn(async () => 1) });
  const db = () => ({ query: vi.fn(answerBySql([[/FROM users/, { rows: [{ id: "u1", phone_number: null, email: null }, { id: "u2", phone_number: null, email: null }] }]])) }) as any;

  it("sends the staff alert to every bell recipient", async () => {
    const d = deps();
    await notifyAllStaff({ pool: db(), skipSms: true, notificationType: "sms_inbound", title: "New SMS from Jane", body: "Jane: hi",
      staffAlert: { category: "SMS", type: "sms", title: "Jane", body: "hi", data: { contactId: CONTACT, threadKind: "sms" } } }, d as any);
    expect(d.sendStaffAlert).toHaveBeenCalledTimes(2);
    expect(d.sendStaffAlert).toHaveBeenCalledWith({ userId: "u1", category: "SMS", type: "sms", title: "Jane", body: "hi", data: { contactId: CONTACT, threadKind: "sms" } });
  });

  it("does not alert the dialler without ctx.staffAlert, and a failure never breaks the fan-out", async () => {
    const d = deps();
    await notifyAllStaff({ pool: db(), notificationType: "task", body: "Task" }, d as any);
    expect(d.sendStaffAlert).not.toHaveBeenCalled();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    d.sendStaffAlert.mockRejectedValue(new Error("apns down"));
    await expect(notifyAllStaff({ pool: db(), notificationType: "voicemail", body: "x", staffAlert: { category: "VOICEMAIL", type: "voicemail" } }, d as any))
      .resolves.toMatchObject({ notifsCreated: 2, recipientCount: 2 });
  });

  it("named recipients replace the all-staff query", async () => {
    const pool = db();
    await notifyAllStaff({ pool, notificationType: "call_missed", body: "Missed call", userIds: ["u9"] }, deps() as any);
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain("id::text = ANY($1::text[])");
    expect(String(sql)).toContain("role IN ('Admin', 'Staff', 'Marketing')");
    expect(params).toEqual([["u9"]]);
  });
});

describe("the five alert events", () => {
  beforeEach(() => { vi.resetModules(); h.notify.mockReset(); });
  async function events() {
    vi.doMock("../notifyAllStaff.js", () => ({ notifyAllStaff: h.notify }));
    return import("../staffAlertEvents.js");
  }

  it("missed call: bell + Watch + dialler for the person the call was for, with the call-back number", async () => {
    h.query.mockImplementation(answerBySql([[/FROM contacts/, { rows: [{ id: CONTACT, name: "Jane Client" }] }]]));
    const { alertMissedCall } = await events();
    await alertMissedCall({ from: "+14035550144", staffUserId: "u7", callSid: "CA-1" });
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({
      userIds: ["u7"], skipSms: true, notificationType: "call_missed", refId: "CA-1",
      watch: expect.objectContaining({ category: "MISSED_CALL", eventType: "missed_call" }),
      staffAlert: { category: "MISSED_CALL", type: "missed_call", title: "Missed call", body: "Jane Client", data: { contactId: CONTACT, phone: "+14035550144" } },
    }));
  });

  it("voicemail: transcript preview clipped to 120", async () => {
    const { alertVoicemail } = await events();
    await alertVoicemail({ from: "+14035550144", callerLabel: "Jane Client", contactId: CONTACT, transcript: "y".repeat(400), recordingSid: "RE1" });
    const ctx = h.notify.mock.calls[0][0];
    expect(ctx.staffAlert).toMatchObject({ category: "VOICEMAIL", type: "voicemail", title: "Voicemail from Jane Client" });
    expect(ctx.staffAlert.body.length).toBeLessThanOrEqual(120);
    expect(ctx.watch).toMatchObject({ category: "MISSED_CALL", eventType: "voicemail" });
    expect(ctx.userIds).toBeUndefined(); // no owner -> all staff, like the bell
  });

  it("client-portal message and Maya handoff", async () => {
    h.query.mockImplementation(answerBySql([[/FROM applications a LEFT JOIN contacts c/, { rows: [{ contact_id: CONTACT, name: "Jane Client", silo: "BF" }] }]]));
    const { alertClientMessage, alertMayaHandoff } = await events();
    await alertClientMessage({ messageId: "m1", applicationId: APP_ID, body: "Here are my statements" });
    await alertMayaHandoff({ escalationId: "e1", contactId: CONTACT, summary: "Wants to talk about rates", phone: "403-555-0144" });
    const [msg, handoff] = h.notify.mock.calls.map((c) => c[0]);
    expect(msg.staffAlert).toEqual({ category: "CLIENT_MESSAGE", type: "client_message", title: "Message from Jane Client", body: "Here are my statements",
      data: { contactId: CONTACT, applicationId: APP_ID, threadKind: "messages", senderName: "Jane Client" } }); // v822
    expect(msg.watch).toMatchObject({ category: "MESSAGE", eventType: "client_message" });
    expect(handoff.staffAlert).toMatchObject({ category: "HANDOFF", type: "maya_handoff", body: "Wants to talk about rates", data: { contactId: CONTACT, phone: "+14035550144" } });
  });

  it("never throws when the fan-out fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.notify.mockRejectedValue(new Error("db down"));
    const { alertMissedCall } = await events();
    await expect(alertMissedCall({ from: "+14035550144" })).resolves.toBeUndefined();
  });
});
