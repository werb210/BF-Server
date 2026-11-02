// BF_SERVER_v871_CALL_QUEUES - the 866 line and call queues: with no queue chosen the greeting is exactly as before;
// an option pointing at a queue (and the main line, when an Admin sends it to one) puts the caller in a Twilio
// <Enqueue>; an archived queue falls back to the menu's no-answer route.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultBorealMenu } from "../../phoneMenu/menu.js";

const Q1 = "33333333-3333-4333-8333-333333333333";
const CALL_ROW = "55555555-5555-4555-8555-555555555555";
const state = vi.hoisted(() => ({ mainLine: null as string | null, archived: false, savedMenu: null as unknown }));

vi.mock("../../middleware/twilioWebhookValidation.js", () => ({ twilioWebhookValidation: (_req: any, _res: any, next: any) => next() }));
vi.mock("../../db.js", async () => {
  const { answerBySql: rules } = await import("../../__tests__/helpers/answerBySql.js");
  return {
    pool: {
      query: rules([
        [/FROM phone_menu_config/, () => ({ rows: state.savedMenu ? [{ config: state.savedMenu, updated_at: null }] : [] })],
        [/FROM boreal_settings WHERE key = \$1/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === "call_queue_main_line" && state.mainLine ? [{ value: { queue_id: state.mainLine } }] : [] })],
        [/SELECT \* FROM call_queues/, () => ({ rows: [{ id: Q1, silo: "BF", name: "Sales", greeting: "", hold_message: "", hold_audio_id: null, announce_position: true, max_wait_seconds: 300, ring_seconds: 20, overflow: "voicemail", overflow_user_id: null, archived_at: state.archived ? new Date() : null }] })],
        [/SELECT id::text AS id FROM call_queue_calls WHERE call_sid/, { rows: [{ id: CALL_ROW }] }],
      ]),
    },
  };
});

async function app() { const { default: router } = await import("../reception.js"); const a = express(); a.use("/api/webhooks/twilio/reception", router); return a; }
const post = async (path: string, body: Record<string, string> = {}) =>
  (await request(await app()).post("/api/webhooks/twilio/reception" + path).type("form").send({ CallSid: "CA" + "1".repeat(32), From: "+14035550111", ...body })).text;

function menuWithQueueOnTwo() {
  const m = defaultBorealMenu();
  m.options = m.options.map((o) => (o.digit === "2" ? { ...o, target: { type: "queue", queueId: Q1 } as const } : o));
  return m;
}

beforeEach(() => { state.mainLine = null; state.archived = false; state.savedMenu = null; });

describe("v871 call queues on the 866 line", () => {
  it("no queue chosen: the greeting and menu are exactly as before", async () => {
    const xml = await post("/greeting");
    expect(xml).toContain("This call may be recorded. Thank you for calling the Boreal Group of Companies.");
    expect(xml).toContain("<Gather");
    expect(xml).not.toContain("<Enqueue");
  });

  it("a menu option pointing at a queue puts the caller in it with hold music and place in line", async () => {
    state.savedMenu = menuWithQueueOnTwo();
    const xml = await post("/company", { Digits: "2" });
    expect(xml).toContain(`<Enqueue action="/api/webhooks/twilio/queue/left?qc=${CALL_ROW}" method="POST" waitUrl="/api/webhooks/twilio/queue/wait?qc=${CALL_ROW}" waitUrlMethod="POST">bf-q-${Q1}</Enqueue>`);
    expect(xml).not.toContain("<Record");
  });

  it("an archived queue sends the caller to the no-answer route (shared voicemail)", async () => {
    state.savedMenu = menuWithQueueOnTwo();
    state.archived = true;
    const xml = await post("/company", { Digits: "2" });
    expect(xml).not.toContain("<Enqueue");
    expect(xml).toContain("<Record");
  });

  it("with a main-line queue, callers hear the greeting and wait in the queue", async () => {
    state.mainLine = Q1;
    const xml = await post("/greeting");
    expect(xml).toContain("Thank you for calling the Boreal Group of Companies.");
    expect(xml).toContain(`bf-q-${Q1}</Enqueue>`);
    expect(xml).not.toContain("<Gather");
    // The greeting already says the call may be recorded: the notice is not repeated.
    expect(xml.match(/may be recorded/g)).toHaveLength(1);
  });

  it("a main-line queue that was archived leaves callers with the phone menu", async () => {
    state.mainLine = Q1;
    state.archived = true;
    const xml = await post("/greeting");
    expect(xml).toContain("<Gather");
    expect(xml).not.toContain("<Enqueue");
  });
});
