// BF_SERVER_v821_DIALER - voicemail text on the iPhone / Watch alert ("{caller}: {transcript excerpt}", <=120, with a
// top-level voicemailId), and Focus break-through (interruption-level time-sensitive + relevance-score) on every
// staff alert category.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), notify: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, dbQuery: h.query, runQuery: h.query }));

import { buildStaffAlertPayload, STAFF_ALERT_CATEGORIES, STAFF_ALERT_RELEVANCE } from "../services/notifications/staffAlerts.js";
import { configureWatchPushProvider, sendWatchNotification } from "../watch/notifications.js";

const CONTACT = "c0c0c0c0-0000-4000-8000-000000000002";
const VOICEMAIL = "f0f0f0f0-0000-4000-8000-000000000005";

beforeEach(() => { h.query.mockReset(); h.query.mockImplementation(answerBySql([])); h.notify.mockReset(); });
afterEach(() => { vi.doUnmock("../services/notifications/notifyAllStaff.js"); vi.resetModules(); configureWatchPushProvider(null); vi.restoreAllMocks(); });

describe("Focus: staff alerts are time-sensitive with a relevance score", () => {
  it.each(STAFF_ALERT_CATEGORIES.map((c) => [c]))("%s", (category) => {
    const payload = buildStaffAlertPayload({ title: "T", body: "B", category, type: "missed_call" }) as any;
    expect(payload.aps["interruption-level"]).toBe("time-sensitive");
    const score = payload.aps["relevance-score"];
    expect(score).toBe(STAFF_ALERT_RELEVANCE[category]);
    expect(score).toBeGreaterThanOrEqual(0.5);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("covers MISSED_CALL, VOICEMAIL, CLIENT_MESSAGE, SMS and HANDOFF", () => {
    expect([...STAFF_ALERT_CATEGORIES].sort()).toEqual(["CLIENT_MESSAGE", "HANDOFF", "MISSED_CALL", "SMS", "VOICEMAIL"]);
  });
});

describe("voicemail alert", () => {
  async function events() {
    vi.resetModules();
    vi.doMock("../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: h.notify }));
    return import("../services/notifications/staffAlertEvents.js");
  }

  it("body is '{caller}: {transcript excerpt}' clipped to 120 with an ellipsis; voicemailId reaches the app and the Watch", async () => {
    const { alertVoicemail } = await events();
    await alertVoicemail({ from: "+14035550144", callerLabel: "Jane Client", contactId: CONTACT, transcript: "Hi it's Jane, " + "please call me back about the loan ".repeat(8), recordingSid: "RE1", voicemailId: VOICEMAIL });
    const ctx = h.notify.mock.calls[0][0];
    expect(ctx.staffAlert.body.startsWith("Jane Client: Hi it's Jane, please call me back")).toBe(true);
    expect(ctx.staffAlert.body).toHaveLength(120);
    expect(ctx.staffAlert.body.endsWith("…")).toBe(true);
    expect(ctx.staffAlert.data).toMatchObject({ contactId: CONTACT, phone: "+14035550144", voicemailId: VOICEMAIL });
    expect(ctx.watch).toMatchObject({ category: "MISSED_CALL", eventType: "voicemail", body: ctx.staffAlert.body, voicemailId: VOICEMAIL });
  });

  it("no transcript yet: '{caller}: New voicemail'; an unknown caller is the number", async () => {
    const { voicemailAlertBody } = await events();
    expect(voicemailAlertBody("+14035550144", "")).toBe("+14035550144: New voicemail");
    expect(voicemailAlertBody("Jane Client", "  short  message ")).toBe("Jane Client: short message");
  });

  it("the APNs payload carries voicemailId top-level (UUIDs only)", () => {
    const p = buildStaffAlertPayload({ title: "Voicemail from Jane", body: "Jane: hi", category: "VOICEMAIL", type: "voicemail", data: { voicemailId: VOICEMAIL } }) as any;
    expect(p.voicemailId).toBe(VOICEMAIL);
    expect((buildStaffAlertPayload({ title: "x", body: "y", category: "VOICEMAIL", type: "voicemail", data: { voicemailId: "RE123" } }) as any).voicemailId).toBeUndefined();
  });

  it("the Watch payload carries voicemailId top-level", async () => {
    const send = vi.fn(async () => undefined);
    configureWatchPushProvider({ send });
    const query = vi.fn(async () => ({ rows: [{ id: "d1", device_id: "d1", token_ciphertext: "x", environment: "production" }] }));
    await sendWatchNotification(
      { staffUserId: "u1", category: "MISSED_CALL", eventType: "voicemail", title: "Voicemail", body: "Jane: hi", voicemailId: VOICEMAIL },
      { query: query as any, decrypt: () => "token" },
    );
    expect((send.mock.calls[0] as any[])[1]).toMatchObject({ type: "voicemail", voicemailId: VOICEMAIL, aps: { alert: { body: "Jane: hi" } } });
  });
});
