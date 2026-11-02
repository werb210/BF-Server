// BF_SERVER_v869_SETTINGS_PACK_TASK_DEFAULTS - follow-up prompt defaults per person.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: h.query }, db: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});

import { DEFAULT_TASK_DEFAULTS, dueAt, suggestion, validateDefaults } from "../taskDefaults.js";

const ME = "22222222-2222-4222-8222-222222222222";
const CONTACT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let saved: unknown[] | null;
beforeEach(() => {
  h.query.mockReset(); saved = null;
  h.query.mockImplementation(answerBySql([
    [/FROM users\s+WHERE id = \$1|FROM users WHERE id/, (_s: string, p?: unknown[]) => ({ rows: [{ id: p?.[0], role: "Staff", active: true, status: "ACTIVE", token_version: 0, disabled: false }] })],
    [/FROM user_task_defaults WHERE user_id/, () => ({ rows: saved ? [{ prompt_after_call: saved[1], prompt_after_email: saved[2], prompt_after_meeting: saved[3], due_in_days: saved[4], due_time: saved[5], task_type: saved[6], reminder_minutes: saved[7] }] : [] })],
    [/INSERT INTO user_task_defaults/, (_s: string, p?: unknown[]) => { saved = p ?? null; return { rows: [] }; }],
    [/FROM contacts WHERE id::text = \$1/, { rows: [{ name: "Pat Lee" }] }],
  ]));
});

describe("follow-up defaults", () => {
  it("due N days on at the default time (Alberta time), skipping the weekend", () => {
    // Thursday 2026-12-10 15:00 Alberta; due in 1 day at 09:00 -> Friday 09:00 (15:00Z).
    expect(dueAt({ due_in_days: 1, due_time: "09:00" }, new Date("2026-12-10T21:00:00Z")).toISOString()).toBe("2026-12-11T15:00:00.000Z");
    // Friday + 1 -> Saturday -> Monday 09:00.
    expect(dueAt({ due_in_days: 1, due_time: "09:00" }, new Date("2026-12-11T21:00:00Z")).toISOString()).toBe("2026-12-14T15:00:00.000Z");
    // "Today at 09:00" when it is already afternoon -> tomorrow.
    expect(dueAt({ due_in_days: 0, due_time: "09:00" }, new Date("2026-12-09T21:00:00Z")).toISOString()).toBe("2026-12-10T15:00:00.000Z");
  });

  it("validates and fills the prompt", () => {
    expect(validateDefaults({ due_time: "9am", task_type: "FAX", due_in_days: 99 }).ok).toBe(false);
    const s = suggestion({ ...DEFAULT_TASK_DEFAULTS, reminder_minutes: 30 }, "call", "Pat Lee", new Date("2026-12-10T21:00:00Z"));
    expect(s).toMatchObject({ prompt: true, type: "CALL", title: "Call Pat Lee - follow-up after the call", due_at: "2026-12-11T15:00:00.000Z", reminder_at: "2026-12-11T14:30:00.000Z" });
    expect(suggestion({ ...DEFAULT_TASK_DEFAULTS, prompt_after_email: false }, "email", null).prompt).toBe(false);
  });

  it("each person saves their own and gets the prompt pre-filled", async () => {
    const a = express();
    a.use(express.json());
    a.use("/api/task-defaults", (await import("../../routes/taskDefaults.js")).default);
    const tok = jwt.sign({ sub: ME, id: ME, role: "Staff", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
    expect((await request(a).put("/api/task-defaults/me").set("Authorization", `Bearer ${tok}`).send({ defaults: { due_time: "25:00" } })).status).toBe(400);
    const put = await request(a).put("/api/task-defaults/me").set("Authorization", `Bearer ${tok}`).send({ defaults: { due_in_days: 2, due_time: "10:30", task_type: "EMAIL", reminder_minutes: null, prompt_after_meeting: false } });
    expect(put.status).toBe(200);
    expect(callsMatching(h.query, /INSERT INTO user_task_defaults/)[0]![1]![0]).toBe(ME);
    const sug = await request(a).get(`/api/task-defaults/suggestion?after=meeting&contact_id=${CONTACT}`).set("Authorization", `Bearer ${tok}`);
    expect(sug.body).toMatchObject({ ok: true, prompt: false, type: "EMAIL", title: "Email Pat Lee - follow-up after the meeting", reminder_at: null, contact_id: CONTACT });
    expect((await request(a).get("/api/task-defaults/suggestion?after=lunch").set("Authorization", `Bearer ${tok}`)).status).toBe(400);
  });
});
