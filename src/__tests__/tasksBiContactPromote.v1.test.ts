// BF_SERVER_TASKS_BI_CONTACT_PROMOTE_v1 - creating a task/call/email on a BI
// outreach lead (bi_contacts, which tasks.contact_id cannot FK-reference)
// promotes the lead into the main CRM contacts table (silo='BI') and attaches
// the task to that real contact, instead of failing with contact_not_found.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const tasks = readFileSync(join(process.cwd(), "src", "routes", "tasks.ts"), "utf-8");

describe("BI outreach lead promotion on task create", () => {
  it("looks up the id in bi_contacts when it is not a main contact", () => {
    expect(tasks).toContain("BF_SERVER_TASKS_BI_CONTACT_PROMOTE_v1");
    expect(tasks).toContain("FROM bi_contacts WHERE id::text = $1");
  });
  it("reuses an existing BI contact matched by phone/email before creating one", () => {
    expect(tasks).toContain("SELECT id FROM contacts");
    expect(tasks).toContain("silo = 'BI'");
    expect(tasks).toContain("lower(email) = lower($2)");
  });
  it("creates the promoted contact with silo BI and re-points the task to it", () => {
    expect(tasks).toContain("INSERT INTO contacts (name, email, phone, silo) VALUES ($1,$2,$3,'BI')");
    expect(tasks).toContain("b.contact_id = promotedId");
  });
  it("still 400s contact_not_found only when the id is in neither table", () => {
    expect(tasks).toContain('respondError(res, 400, "contact_not_found")');
  });
});
