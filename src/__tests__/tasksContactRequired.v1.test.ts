// BF_SERVER_TASKS_CONTACT_REQUIRED_v1 - Call/Email/SMS tasks require a contact;
// runs only include contact-attached Call/Email/SMS tasks (To-do excluded).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const src = readFileSync(join(process.cwd(), "src", "routes", "tasks.ts"), "utf-8");
describe("tasks contact-required", () => {
  it("create rejects Call/Email/SMS without a contact", () => {
    expect(src).toContain('["CALL", "EMAIL", "SMS"].includes(type) && !s(b.contact_id)');
    expect(src).toContain('"contact_required_for_"');
  });
  it("runs exclude To-do and require a contact", () => {
    expect(src).toContain('"t.contact_id IS NOT NULL"');
    expect(src).toContain(`"t.type IN ('CALL','EMAIL','SMS')"`);
  });
});
