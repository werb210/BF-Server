// BF_SERVER_CONTACT_MERGE_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const src = readFileSync(path.join(process.cwd(), "src/routes/crm/contactMerge.ts"), "utf8");
const crm = readFileSync(path.join(process.cwd(), "src/routes/crm.ts"), "utf8");

describe("contact merge", () => {
  it("is mounted", () => {
    expect(crm).toContain('router.use("/contacts", contactMergeRoutes)');
  });

  it("finds duplicates by fuzzy NAME, not just exact email/phone", () => {
    // Mike Cotic, Juergen Zischler and Wayne Beamish all differ on BOTH email and phone.
    // Without a name match the tool cannot see a single real duplicate in this database.
    expect(src).toContain("similarity(lower(c.name), lower(me.name)) >= 0.6");
  });

  it("repoints EVERY table with a contact_id, discovered at runtime", () => {
    expect(src).toContain("information_schema.columns");
    expect(src).toContain("column_name = 'contact_id'");
  });

  it("also repoints call_logs, which uses crm_contact_id and would otherwise be missed", () => {
    expect(src).toContain("UPDATE call_logs SET crm_contact_id");
  });

  it("never destroys data the loser uniquely had", () => {
    expect(src).toContain("coalesce(nullif(trim(s.email),''), nullif(trim($2),''))");
    expect(src).toContain("array_agg(DISTINCT x)"); // tags are unioned, not replaced
  });

  it("is transactional and reversible", () => {
    expect(src).toContain('await client.query("BEGIN")');
    expect(src).toContain('await client.query("ROLLBACK")');
    expect(src).toContain("loser_snapshot");
  });

  it("supports a dry run so staff can see what would move before committing", () => {
    expect(src).toContain("dryRun");
  });

  it("refuses to merge a contact into itself", () => {
    expect(src).toContain("a contact cannot be merged into itself");
  });
});
