// BF_SERVER_v869_SETTINGS_PACK_TASK_DEFAULTS - follow-up task defaults per person (Settings > My Profile > Follow-ups). After a
// call, email or meeting the portal asks "Create a follow-up?" (each can be switched off), pre-filled with the
// person's default due day and time (brokerage time zone, weekends skipped), task type and reminder.
import { brokerageTimeZone, zonedParts, zonedTime } from "../settingsPack/boreal.js";
import type { Q } from "../settingsPack/common.js";

export const TASK_TYPES = ["CALL", "EMAIL", "SMS", "TODO"] as const;
export type FollowUpAfter = "call" | "email" | "meeting";

export type TaskDefaults = {
  prompt_after_call: boolean; prompt_after_email: boolean; prompt_after_meeting: boolean;
  due_in_days: number; due_time: string; task_type: (typeof TASK_TYPES)[number]; reminder_minutes: number | null;
};
export const DEFAULT_TASK_DEFAULTS: TaskDefaults = {
  prompt_after_call: true, prompt_after_email: true, prompt_after_meeting: true,
  due_in_days: 1, due_time: "09:00", task_type: "CALL", reminder_minutes: 15,
};

export function validateDefaults(raw: unknown): { ok: true; value: TaskDefaults } | { ok: false; errors: Record<string, string> } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const d = DEFAULT_TASK_DEFAULTS;
  const errors: Record<string, string> = {};
  const days = r.due_in_days === undefined ? d.due_in_days : Math.round(Number(r.due_in_days));
  if (!Number.isFinite(days) || days < 0 || days > 60) errors.due_in_days = "Due 0 to 60 days later.";
  const time = r.due_time === undefined ? d.due_time : String(r.due_time);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) errors.due_time = "Use a time like 09:00.";
  const type = r.task_type === undefined ? d.task_type : String(r.task_type).toUpperCase();
  if (!(TASK_TYPES as readonly string[]).includes(type)) errors.task_type = "Choose call, email, text or to-do.";
  const rem = r.reminder_minutes === undefined ? d.reminder_minutes : r.reminder_minutes === null || r.reminder_minutes === "" ? null : Math.round(Number(r.reminder_minutes));
  if (rem !== null && (!Number.isFinite(rem) || rem < 0 || rem > 10080)) errors.reminder_minutes = "A reminder 0 minutes to 7 days before, or none.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: {
    prompt_after_call: r.prompt_after_call !== false, prompt_after_email: r.prompt_after_email !== false, prompt_after_meeting: r.prompt_after_meeting !== false,
    due_in_days: days, due_time: time, task_type: type as TaskDefaults["task_type"], reminder_minutes: rem,
  } };
}

export async function defaultsFor(db: Q, userId: string): Promise<TaskDefaults> {
  const r = await db.query(
    `SELECT prompt_after_call, prompt_after_email, prompt_after_meeting, due_in_days, due_time, task_type, reminder_minutes
       FROM user_task_defaults WHERE user_id::text = $1`, [userId]);
  const row = r.rows[0];
  return row ? { ...row, due_in_days: Number(row.due_in_days), reminder_minutes: row.reminder_minutes === null ? null : Number(row.reminder_minutes) } as TaskDefaults : { ...DEFAULT_TASK_DEFAULTS };
}

export async function saveDefaults(db: Q, userId: string, v: TaskDefaults): Promise<void> {
  await db.query(
    `INSERT INTO user_task_defaults (user_id, prompt_after_call, prompt_after_email, prompt_after_meeting, due_in_days, due_time, task_type, reminder_minutes, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (user_id) DO UPDATE SET prompt_after_call = EXCLUDED.prompt_after_call, prompt_after_email = EXCLUDED.prompt_after_email,
       prompt_after_meeting = EXCLUDED.prompt_after_meeting, due_in_days = EXCLUDED.due_in_days, due_time = EXCLUDED.due_time,
       task_type = EXCLUDED.task_type, reminder_minutes = EXCLUDED.reminder_minutes, updated_at = now()`,
    [userId, v.prompt_after_call, v.prompt_after_email, v.prompt_after_meeting, v.due_in_days, v.due_time, v.task_type, v.reminder_minutes]);
}

/** The due moment: N days on (Saturday and Sunday move to Monday) at the default time, brokerage time zone. */
export function dueAt(d: Pick<TaskDefaults, "due_in_days" | "due_time">, now: Date = new Date(), tz: string = brokerageTimeZone()): Date {
  const p = zonedParts(new Date(now.getTime() + d.due_in_days * 86_400_000), tz);
  let day = zonedTime(p.y, p.m, p.d, 12, 0, tz);
  const dow = zonedParts(day, tz).dow;
  if (dow === 6) day = new Date(day.getTime() + 2 * 86_400_000);
  if (dow === 0) day = new Date(day.getTime() + 86_400_000);
  const q = zonedParts(day, tz);
  const [h, m] = d.due_time.split(":").map(Number);
  let at = zonedTime(q.y, q.m, q.d, h!, m!, tz);
  // "Today at 9:00" when it is already past 9:00 means the next working day.
  if (at.getTime() <= now.getTime()) at = dueAt({ ...d, due_in_days: d.due_in_days + 1 }, now, tz);
  return at;
}

/** What the "Create a follow-up?" prompt is pre-filled with, or prompt:false when this person switched it off. */
export function suggestion(d: TaskDefaults, after: FollowUpAfter, contactName: string | null, now: Date = new Date()) {
  const prompt = after === "call" ? d.prompt_after_call : after === "email" ? d.prompt_after_email : d.prompt_after_meeting;
  const due = dueAt(d, now);
  const verb = d.task_type === "CALL" ? "Call" : d.task_type === "EMAIL" ? "Email" : d.task_type === "SMS" ? "Text" : "Follow up with";
  return {
    prompt,
    title: `${verb} ${contactName || "the client"} - follow-up after the ${after}`,
    type: d.task_type,
    due_at: due.toISOString(),
    reminder_at: d.reminder_minutes === null ? null : new Date(due.getTime() - d.reminder_minutes * 60_000).toISOString(),
  };
}
