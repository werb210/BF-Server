// BF_ANDROID_STAFF_v1 - the Android apps: the staff portal's Firebase token is registered as "portal-android" and the
// dialler's as "dialer-android" (kept exactly as sent), alerts reach both through Firebase as data-only messages, and
// the dialler's voice token names the Android (FCM) Twilio push credential.
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";
import { mountRouter, staffToken, STAFF_USER_ID } from "../../../__tests__/helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../../db.js", async () => ({ ...(await vi.importActual<any>("../../../db.js")), pool: { query: h.query }, dbQuery: h.query, runQuery: h.query }));

import { __setStaffPushProvider, buildStaffFcmData, sendStaffAlert, staffPushTokenOf } from "../staffAlerts.js";
import { __setFcmProvider, FcmError, type FirebaseFcmProvider } from "../../fcmProvider.js";
import { parseVoiceTokenApp, pushCredentialGrant } from "../../../telephony/services/tokenService.js";

const FCM = "dK3x9_aB-12:APA91b" + "Hk7_Qw-3".repeat(18);
const APNS = "a".repeat(64);
const CONTACT = "c0c0c0c0-0000-4000-8000-000000000002";

beforeEach(() => { h.query.mockReset(); h.query.mockImplementation(answerBySql([])); });
afterEach(() => { __setStaffPushProvider(null); __setFcmProvider(null); vi.restoreAllMocks(); });

describe("POST /api/staff/push-token for the Android app", () => {
  const app = async () => mountRouter((await import("../../../routes/staffPushToken.js")).default, "/api/staff/push-token");

  it("stores the FCM token exactly as sent (case-sensitive) under portal-android", async () => {
    const res = await request(await app()).post("/api/staff/push-token").set("Authorization", `Bearer ${staffToken("Staff")}`)
      .send({ token: ` ${FCM} `, app: "portal-android", environment: "production" });
    expect(res.status).toBe(200);
    expect(callsMatching(h.query, /INSERT INTO staff_push_tokens/)[0]![1]).toEqual([STAFF_USER_ID, FCM, "production", "portal-android"]);
  });

  it("refuses an FCM token for an Apple app and a hex token for the Android app", async () => {
    const auth = { Authorization: `Bearer ${staffToken("Staff")}` };
    expect((await request(await app()).post("/api/staff/push-token").set(auth).send({ token: FCM, app: "portal-ios" })).status).toBe(400);
    expect((await request(await app()).post("/api/staff/push-token").set(auth).send({ token: APNS, app: "portal-android" })).status).toBe(400);
  });

  it("stores the Android dialler's FCM token under dialer-android", async () => {
    const res = await request(await app()).post("/api/staff/push-token").set("Authorization", `Bearer ${staffToken("Staff")}`)
      .send({ token: FCM, app: "dialer-android" });
    expect(res.status).toBe(200);
    expect(callsMatching(h.query, /INSERT INTO staff_push_tokens/)[0]![1]).toEqual([STAFF_USER_ID, FCM, "production", "dialer-android"]);
    const bad = await request(await app()).post("/api/staff/push-token").set("Authorization", `Bearer ${staffToken("Staff")}`)
      .send({ token: APNS, app: "dialer-android" });
    expect(bad.status).toBe(400);
  });

  it("removes an Android token on sign-out", async () => {
    const res = await request(await app()).delete("/api/staff/push-token").set("Authorization", `Bearer ${staffToken("Staff")}`).send({ token: FCM });
    expect(res.status).toBe(200);
    expect(callsMatching(h.query, /DELETE FROM staff_push_tokens/)[0]![1]).toEqual([FCM, STAFF_USER_ID]);
  });

  it("token rules per app", () => {
    expect(staffPushTokenOf(FCM, "portal-android")).toBe(FCM);
    expect(staffPushTokenOf(FCM, "dialer-android")).toBe(FCM);
    expect(staffPushTokenOf("short", "portal-android")).toBeNull();
    expect(staffPushTokenOf("A".repeat(64), "dialer-ios")).toBe("a".repeat(64));
  });
});

describe("staff alerts to the Android app", () => {
  const input = {
    userId: STAFF_USER_ID, title: "Missed call from Jane", body: "Jane Smith  called", category: "MISSED_CALL" as const,
    type: "missed_call" as const, data: { contactId: CONTACT, phone: "+14035550199", url: "javascript:alert(1)" },
  };

  it("builds data with the category, the allowlisted ids and a safe portal path", () => {
    expect(buildStaffFcmData(input)).toEqual({
      schema: "1", categoryId: "MISSED_CALL", type: "missed_call", contactId: CONTACT, phone: "+14035550199", url: "/communications",
    });
    expect(buildStaffFcmData({ ...input, category: "TASK", type: "task_due", data: {} }).url).toBe("/tasks");
    expect(buildStaffFcmData({ ...input, data: { url: "/crm/contacts/" + CONTACT } }).url).toBe("/crm/contacts/" + CONTACT);
  });

  it("sends through Firebase only to Android rows when only Firebase is configured", async () => {
    const send = vi.fn(async () => undefined);
    __setFcmProvider({ send } as unknown as FirebaseFcmProvider);
    h.query.mockImplementation(answerBySql([[/FROM staff_push_tokens/, { rows: [
      { id: "t1", token: APNS, environment: "production", app: "dialer-ios" },
      { id: "t2", token: FCM, environment: "production", app: "portal-android" },
      { id: "t3", token: FCM.replace("dK3", "eL4"), environment: "production", app: "dialer-android" },
    ] }]]));
    expect(await sendStaffAlert(input)).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    const [target, payload] = send.mock.calls[0] as unknown as [{ token: string }, { title: string; body: string; data: Record<string, string> }];
    expect(target).toEqual({ token: FCM });
    expect(payload.title).toBe("Missed call from Jane");
    expect(payload.body).toBe("Jane Smith called");
    expect(payload.data.categoryId).toBe("MISSED_CALL");
  });

  it("drops an unregistered Android token and records other failures", async () => {
    const send = vi.fn(async () => { throw new FcmError("fcm_send_failed_404:UNREGISTERED", true); });
    __setFcmProvider({ send } as unknown as FirebaseFcmProvider);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.query.mockImplementation(answerBySql([[/FROM staff_push_tokens/, { rows: [{ id: "t2", token: FCM, environment: "production", app: "portal-android" }] }]]));
    expect(await sendStaffAlert(input)).toBe(0);
    expect(callsMatching(h.query, /DELETE FROM staff_push_tokens/)[0]![1]).toEqual(["t2"]);

    h.query.mockClear();
    send.mockImplementation(async () => { throw new FcmError("fcm_send_failed_500:oops", false); });
    expect(await sendStaffAlert(input)).toBe(0);
    expect(callsMatching(h.query, /UPDATE staff_push_tokens SET last_error/)[0]![1]).toEqual(["t2", "fcm_send_failed_500:oops"]);
  });
});

describe("voice token for the Android dialler", () => {
  it("names the Android (FCM) Twilio push credential", () => {
    const CR = "CR" + "c".repeat(32);
    expect(parseVoiceTokenApp("dialer-android")).toBe("dialer-android");
    expect(parseVoiceTokenApp(["dialer-android"])).toBe("dialer-android");
    expect(parseVoiceTokenApp("android")).toBe("dialer-android");
    // the Android staff portal hands calls to the dialler, so it never gets a calling token of its own
    expect(parseVoiceTokenApp("portal-android")).toBe("dialer");
    expect(pushCredentialGrant({ TWILIO_PUSH_CREDENTIAL_SID_ANDROID: CR } as any, "dialer-android")).toEqual({ pushCredentialSid: CR });
    expect(pushCredentialGrant({ TWILIO_PUSH_CREDENTIAL_SID: CR } as any, "dialer-android")).toEqual({});
    expect(pushCredentialGrant({ TWILIO_PUSH_CREDENTIAL_SID_ANDROID: "nope" } as any, "dialer-android")).toEqual({});
  });
});
