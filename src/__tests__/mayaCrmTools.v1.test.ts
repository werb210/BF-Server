import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
const src = readFileSync(fileURLToPath(new URL("../routes/mayaStaff.ts", import.meta.url)), "utf-8");
describe("Maya CRM tools", () => {
  it("exposes read+act CRM endpoints", () => {
    for (const p of ["/staff/crm-notes", "/staff/crm-add-note", "/staff/crm-tasks", "/staff/crm-create-task"])
      expect(src).toContain(p);
    expect(src).toContain("INSERT INTO crm_notes");
    expect(src).toContain("INSERT INTO crm_tasks");
  });
});
