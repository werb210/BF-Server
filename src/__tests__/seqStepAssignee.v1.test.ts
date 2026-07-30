// BF_SERVER_SEQ_STEP_ASSIGNEE_v1
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const engine = readFileSync(join(process.cwd(), "src", "services", "sequenceEngine.ts"), "utf-8");
const routes = readFileSync(join(process.cwd(), "src", "routes", "marketing.ts"), "utf-8");
const migration = readFileSync(join(process.cwd(), "migrations", "2026_07_30_seq_step_assignee_v1.sql"), "utf-8");

describe("a BF task step can name its assignee", () => {
  it("prefers the step's assignee over the contact owner", () => {
    expect(engine).toContain("step.assignee_user_id ?? c.owner_id ?? null");
  });
  it("keeps the contact-owner default when none is chosen", () => {
    // The fallback chain must stay: chosen > owner > first active Admin.
    expect(engine).toContain("(SELECT id FROM users WHERE active = true ORDER BY (role = 'Admin') DESC, created_at ASC LIMIT 1)");
  });
  it("reads the column from the steps query", () => {
    expect(engine).toContain("email_template_id, assignee_user_id, task_type");
  });
});

describe("the assignee persists and reads back", () => {
  it("is uuid-guarded on insert", () => {
    expect(routes).toContain("uuidOrNull(st.assigneeUserId ?? st.assignee_user_id)");
  });
  it("is returned when a sequence is read back", () => {
    expect(routes).toContain("email_template_id, assignee_user_id, task_type, task_priority, task_queue_id, task_pause FROM marketing_sequence_steps");
  });
  it("has matching placeholder and column counts", () => {
    const insert = routes.slice(routes.indexOf("INSERT INTO marketing_sequence_steps"), routes.indexOf("st.taskPause !== false]"));
    const columns = (insert.match(/\(sequence_id[^)]+\)/)?.[0] ?? "").split(",").length;
    const placeholders = (insert.match(/VALUES \(([^)]+)\)/)?.[1] ?? "").split(",").length;
    expect(columns).toBe(placeholders);
    expect(columns).toBe(17);
  });
  it("adds the column idempotently and nullable", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS assignee_user_id UUID");
    expect(migration).not.toContain("NOT NULL");
  });
});
