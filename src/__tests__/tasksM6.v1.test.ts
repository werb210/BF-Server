// BF_SERVER_TASKS_M6_v1 (Tasks Milestone 6) - recurrence regeneration on
// complete/delete/overdue, reminder->notification, and the daily digest.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const tasks = readFileSync(join(process.cwd(), "src", "routes", "tasks.ts"), "utf-8");
const worker = readFileSync(join(process.cwd(), "src", "workers", "taskRemindersWorker.ts"), "utf-8");
const idx = readFileSync(join(process.cwd(), "src", "index.ts"), "utf-8");
const mig = readFileSync(join(process.cwd(), "migrations", "2026_07_05_tasks_m6.sql"), "utf-8");
describe("tasks milestone 6", () => {
  it("regenerates recurrence on complete and delete", () => {
    expect((tasks.match(/regenerateRecurrence\(r\.rows\[0\]\)/g) || []).length).toBe(2);
    expect(tasks).toContain("NOT EXISTS (SELECT 1 FROM tasks c WHERE c.repeat_parent_id");
  });
  it("worker runs reminders, overdue recurrence catch-up, and digest", () => {
    expect(worker).toContain("runReminders");
    expect(worker).toContain("runRecurrenceCatchup");
    expect(worker).toContain("runDigest");
    expect(worker).toContain("'task_reminder'");
  });
  it("is mounted at startup and migration is idempotent", () => {
    expect(idx).toContain("startTaskRemindersWorker");
    expect(mig.match(/IF NOT EXISTS/g)!.length).toBe(2);
    expect(mig).toContain("task_digest_log");
  });
});
