// BF_SERVER_TASKS_M6_FIX_v1 - the tasks worker must not cast user ids to text;
// notifications.user_id and task_digest_log.user_id are uuid.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const worker = readFileSync(join(process.cwd(), "src", "workers", "taskRemindersWorker.ts"), "utf-8");
const fix = readFileSync(join(process.cwd(), "migrations", "2026_07_05_tasks_m6_fix.sql"), "utf-8");
describe("tasks m6 uuid fix", () => {
  it("worker no longer casts assignee_user_id to text", () => {
    expect(worker).not.toContain("assignee_user_id::text");
    expect(worker).toContain("SELECT t.assignee_user_id, 'task_reminder'");
  });
  it("fix migration aligns task_digest_log.user_id to uuid, guarded", () => {
    expect(fix).toContain("ALTER COLUMN user_id TYPE uuid");
    expect(fix).toContain("data_type <> 'uuid'");
  });
});
