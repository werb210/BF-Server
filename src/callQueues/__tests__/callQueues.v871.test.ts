// BF_SERVER_v871_CALL_QUEUES - call queues: settings checks, the phone-menu target, who gets the call, and what the
// iPhone dialler is told about a queue call.
import { describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { defaultBorealMenu, validateMenu } from "../../phoneMenu/menu.js";
import { markConnected, offerParameters, pickOffer, twilioQueueName, validateQueue } from "../queues.js";

const U1 = "11111111-1111-4111-8111-111111111111", U2 = "22222222-2222-4222-8222-222222222222";
const Q1 = "33333333-3333-4333-8333-333333333333";
const C1 = "44444444-4444-4444-8444-444444444444";

describe("call queue settings", () => {
  it("checks name, members, waits, ring time, recordings and the overflow voicemail", () => {
    const bad = validateQueue({ name: "", member_ids: ["nobody"], max_wait_seconds: 5, ring_seconds: 99, hold_audio_id: "x", overflow_user_id: "y" }, { userIds: [U1], audioIds: [] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["hold_audio_id", "max_wait_seconds", "member_ids", "name", "overflow_user_id", "ring_seconds"]);
    const ok = validateQueue({ name: "Sales", member_ids: [U1, U2, U1], overflow: "ask" }, { userIds: [U1, U2], audioIds: [] });
    expect(ok).toMatchObject({ ok: true, value: { name: "Sales", silo: "BF", member_ids: [U1, U2], max_wait_seconds: 300, ring_seconds: 20, overflow: "ask", announce_position: true } });
  });

  it("a queue belongs to Boreal Financial or Boreal Insurance (anything else is BF)", () => {
    const bi = validateQueue({ name: "PGI", member_ids: [U1], silo: "bi" }, { userIds: [U1], audioIds: [] });
    expect(bi.ok && bi.value.silo).toBe("BI");
    const other = validateQueue({ name: "X", member_ids: [U1], silo: "SLF" }, { userIds: [U1], audioIds: [] });
    expect(other.ok && other.value.silo).toBe("BF");
  });

  it("hold music is the standard music or one of the uploaded phone-menu recordings", () => {
    const ok = validateQueue({ name: "Sales", member_ids: [U1], hold_audio_id: "rec-1" }, { userIds: [U1], audioIds: ["rec-1"] });
    expect(ok.ok && ok.value.hold_audio_id).toBe("rec-1");
    expect(validateQueue({ name: "Sales", member_ids: [U1] }, { userIds: [U1], audioIds: [] })).toMatchObject({ ok: true, value: { hold_audio_id: null } });
  });
});

describe("the phone menu and queues", () => {
  const menu = (target: unknown, extra: Record<string, unknown> = {}) => ({
    greeting: { mode: "tts", text: "Hi" }, afterHoursGreeting: { mode: "tts", text: "Closed" },
    options: [{ id: "sales", digit: "1", label: "sales", keywords: [], target }], ...extra,
  });

  it("an option can point at an active queue only", () => {
    const none = validateMenu(menu({ type: "queue", queueId: Q1 }), { userIds: [U1], audioIds: [] });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.errors["options.0.target"]).toMatch(/Set up a call queue first/);
    const archived = validateMenu(menu({ type: "queue", queueId: Q1 }), { userIds: [U1], audioIds: [], queueIds: [U2] });
    expect(!archived.ok && archived.errors["options.0.target"]).toBe("Choose an active call queue.");
    const ok = validateMenu(menu({ type: "queue", queueId: Q1 }), { userIds: [U1], audioIds: [], queueIds: [Q1] });
    expect(ok.ok && ok.value.options[0]!.target).toEqual({ type: "queue", queueId: Q1 });
  });

  it("a second-level option and the no-answer route can use a queue too", () => {
    const sub = { type: "submenu", menu: { prompt: { mode: "tts", text: "Press 1" }, options: [{ id: "credit", digit: "1", label: "credit", keywords: [], target: { type: "queue", queueId: Q1 } }], whenNoChoice: { retry: false, optionId: null } } };
    expect(validateMenu(menu(sub), { userIds: [U1], audioIds: [], queueIds: [Q1] }).ok).toBe(true);
    const noAnswer = validateMenu(menu({ type: "user", userId: U1, name: "Sam" }, { noAnswer: { ringSeconds: 20, target: { type: "queue", queueId: Q1 } } }), { userIds: [U1], audioIds: [], queueIds: [Q1] });
    expect(noAnswer.ok && noAnswer.value.noAnswer.target).toEqual({ type: "queue", queueId: Q1 });
  });

  it("Boreal's default menu has no queue in it", () => {
    const json = JSON.stringify(defaultBorealMenu());
    expect(json).not.toContain('"queue"');
  });
});

describe("who gets the call", () => {
  it("offers the oldest caller to the longest-idle free member, skipping people who missed this caller", async () => {
    const q = vi.fn(answerBySql([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/FROM call_queue_calls WHERE queue_id = \$1::uuid AND status = 'waiting' ORDER BY enqueued_at/, { rows: [{ id: "c1", skipped: [U1] }] }],
      [/FROM call_queue_members m/, (_s: string, p?: unknown[]) => ({ rows: (p?.[1] as string[]).includes(U1) ? [{ user_id: U2, identity: "sue", idle_since: "2026-10-26T10:00:00Z" }] : [{ user_id: U1, identity: "sam", idle_since: "2026-10-26T09:00:00Z" }] })],
      [/UPDATE call_queue_calls SET status = 'offered'/, { rows: [{ id: "c1" }] }],
    ]));
    expect(await pickOffer({ query: q } as any, Q1)).toEqual({ callId: "c1", userId: U2, identity: "sue" });
  });

  it("someone outside their call hours is passed over for the next free person", async () => {
    const q = vi.fn(answerBySql([
      [/FROM call_queue_calls WHERE queue_id = \$1::uuid AND status = 'waiting' ORDER BY enqueued_at/, { rows: [{ id: "c1", skipped: [] }] }],
      [/FROM call_queue_members m/, { rows: [{ user_id: U1, identity: "sam", idle_since: null }, { user_id: U2, identity: "sue", idle_since: null }] }],
      [/twilio_identity, h.enabled/, { rows: [{ twilio_identity: "sam", enabled: true, timezone: "America/Edmonton", weekly: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] } }] }],
      [/UPDATE call_queue_calls SET status = 'offered'/, { rows: [{ id: "c1" }] }],
    ]));
    expect(await pickOffer({ query: q } as any, Q1)).toEqual({ callId: "c1", userId: U2, identity: "sue" });
  });

  it("starts the round again when everyone free has been tried", async () => {
    const q = vi.fn(answerBySql([
      [/FROM call_queue_calls WHERE queue_id = \$1::uuid AND status = 'waiting' ORDER BY enqueued_at/, { rows: [{ id: "c1", skipped: [U1, U2] }] }],
      [/FROM call_queue_members m/, (_s: string, p?: unknown[]) => ({ rows: (p?.[1] as string[]).length ? [] : [{ user_id: U1, identity: "sam", idle_since: null }] })],
      [/UPDATE call_queue_calls SET status = 'offered'/, { rows: [{ id: "c1" }] }],
    ]));
    expect(await pickOffer({ query: q } as any, Q1)).toEqual({ callId: "c1", userId: U1, identity: "sam" });
    expect(callsMatching(q, /UPDATE call_queue_calls SET status = 'offered'/)[0]![1]).toEqual(["c1", U1, []]);
  });

  it("nobody free: the caller keeps waiting", async () => {
    const q = vi.fn(answerBySql([
      [/FROM call_queue_calls WHERE queue_id = \$1::uuid AND status = 'waiting' ORDER BY enqueued_at/, { rows: [{ id: "c1", skipped: [] }] }],
      [/FROM call_queue_members m/, { rows: [] }],
    ]));
    expect(await pickOffer({ query: q } as any, Q1)).toBeNull();
    expect(callsMatching(q, /UPDATE call_queue_calls/)).toHaveLength(0);
  });

  it("when an agent's call dequeues a different caller than offered, the two offers swap", async () => {
    const q = vi.fn(answerBySql([
      [/FROM call_queue_calls WHERE call_sid = \$1/, { rows: [{ id: "front", user_id: U1, offer_call_sid: "CAsam" }] }],
      [/FROM call_queue_calls WHERE offer_call_sid = \$1/, { rows: [{ id: "second", user_id: U2 }] }],
    ]));
    expect(await markConnected({ query: q }, "CAcallerFront", "CAsue")).toEqual({ callId: "front", userId: U2 });
    const updates = callsMatching(q, /UPDATE call_queue_calls/);
    expect(updates[0]![1]).toEqual(["second", U1, "CAsam"]);
    expect(updates[1]![1]).toEqual(["front", U2, "CAsue"]);
  });
});

describe("what the dialler shows for a queue call", () => {
  it("names the caller and the queue (the iPhone app reads callerName / callerCompany)", () => {
    expect(offerParameters({ callId: "c1", queueName: "Sales", from: "+14035550111", callerName: "Pat Lee", contactId: C1 }))
      .toEqual({ queueCall: "c1", queueName: "Sales", callerCompany: "Sales queue call", callerName: "Pat Lee", callerNumber: "+14035550111", contactId: C1 });
  });

  it("an unknown caller is shown by number; a bad contact id is dropped", () => {
    const p = offerParameters({ callId: "c1", queueName: null, from: "+14035550199", callerName: null, contactId: "../x" });
    expect(p).toMatchObject({ callerName: "+14035550199", callerCompany: "Queue call" });
    expect(p.contactId).toBeUndefined();
  });

  it("each Twilio queue is named after the queue", () => {
    expect(twilioQueueName(Q1)).toBe(`bf-q-${Q1}`);
  });
});
