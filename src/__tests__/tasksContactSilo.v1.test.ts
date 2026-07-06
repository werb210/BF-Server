// BF_SERVER_TASKS_CONTACT_SILO_v1 - a task attached to a contact/company takes
// that record's silo, instead of rejecting when the request's active silo lags
// the record being viewed (the contact_silo_mismatch a BI contact hit).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const tasks = readFileSync(join(process.cwd(), "src", "routes", "tasks.ts"), "utf-8");

describe("task silo derives from the attached record", () => {
  it("derives silo from the contact when contact_id is present", () => {
    expect(tasks).toContain("BF_SERVER_TASKS_CONTACT_SILO_v1");
    expect(tasks).toContain("SELECT silo FROM contacts WHERE id::text = $1");
  });
  it("derives silo from the company when only company_id is present", () => {
    expect(tasks).toContain("SELECT silo FROM companies WHERE id::text = $1");
  });
  it("no longer rejects with contact_silo_mismatch / company_silo_mismatch", () => {
    expect(tasks).not.toContain("contact_silo_mismatch");
    expect(tasks).not.toContain("company_silo_mismatch");
    // missing records are reported clearly instead
    expect(tasks).toContain("contact_not_found");
    expect(tasks).toContain("company_not_found");
  });
  it("still validates the queue against the resolved (record-derived) silo", () => {
    expect(tasks).toContain("queue_silo_mismatch");
  });
});
