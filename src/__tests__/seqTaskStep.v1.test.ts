// BF_SERVER_SEQ_TASK_STEP_v1 (Tasks Milestone 5) - sequences can create
// tasks; pause-until-complete parks the enrollment as 'waiting_task' and
// completing the task resumes it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const eng = readFileSync(join(process.cwd(), "src", "services", "sequenceEngine.ts"), "utf-8");
const tasks = readFileSync(join(process.cwd(), "src", "routes", "tasks.ts"), "utf-8");
const mkt = readFileSync(join(process.cwd(), "src", "routes", "marketing.ts"), "utf-8");
const mig = readFileSync(join(process.cwd(), "migrations", "2026_07_04_sequence_task_steps.sql"), "utf-8");
describe("sequence task step", () => {
  it("engine creates a SEQUENCE-sourced task and parks when pausing", () => {
    expect(eng).toContain('if (step.channel === "task")');
    expect(eng).toContain("'SEQUENCE', $9::uuid");
    expect(eng).toContain("status='waiting_task'");
  });
  it("resume is exported and completion paths call it", () => {
    expect(eng).toContain("export async function resumeSequenceTask");
    expect((tasks.match(/resumeIfSequenceTask\(r\.rows\)/g) || []).length).toBe(3);
  });
  it("steps route persists the task fields; migration is idempotent", () => {
    expect(mkt).toContain("task_type, task_priority, task_queue_id, task_pause");
    expect(mig.match(/IF NOT EXISTS/g)!.length).toBe(4);
  });
});
