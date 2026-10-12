// BF_SERVER_TASKS_M6_FIX_v1 - the tasks worker must not cast user ids to text;
// notifications.user_id and task_digest_log.user_id are uuid.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

// Run each tick directly: the cross-instance lock is covered by its own tests.
vi.mock("../workers/claim.js", () => ({ claimedTick: (_name: string, fn: () => Promise<unknown>) => async () => { await fn(); } }));

import { startTaskRemindersWorker } from "../workers/taskRemindersWorker.js";

const fix = readFileSync(join(process.cwd(), "migrations", "2026_07_05_tasks_m6_fix.sql"), "utf-8");

async function runTick() {
  const pool = { query: vi.fn(answerBySql([])) };
  const w = startTaskRemindersWorker(pool as any);
  await vi.waitFor(() => expect(callsMatching(pool.query, /UPDATE task_digest_log SET notified_at/)).toHaveLength(1));
  w.stop();
  return pool;
}

afterEach(() => { vi.useRealTimers(); });

describe("tasks m6 uuid fix", () => {
  it("the reminder and digest inserts pass assignee_user_id through as a uuid", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-12T15:00:00Z")); // after 08:00 UTC, so the digest runs
    const pool = await runTick();
    const reminder = String(callsMatching(pool.query, /'task_reminder'/)[0][0]);
    expect(reminder).toContain("SELECT t.assignee_user_id, 'task_reminder'");
    const digest = String(callsMatching(pool.query, /INSERT INTO task_digest_log/)[0][0]);
    expect(digest).toContain("SELECT t.assignee_user_id, current_date");
    for (const [sql] of pool.query.mock.calls) {
      expect(String(sql)).not.toContain("assignee_user_id::text");
      expect(String(sql)).not.toContain("user_id::text");
    }
  });

  it("fix migration aligns task_digest_log.user_id to uuid, guarded", () => {
    expect(fix).toContain("ALTER COLUMN user_id TYPE uuid");
    expect(fix).toContain("data_type <> 'uuid'");
  });
});
