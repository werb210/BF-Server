// BF_SERVER_v960_LENDER_REPS - against a real Postgres: reps are kept under the lender (and in the CRM under the
// lender's company, never as marketing contacts), one is chosen per file and lender, and the choice can be cleared.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import { rerunMigration } from "./helpers/rerunMigration.js";
import { fileLenderReps, listReps, parseRep, repForFile, saveRep, setRepForFile } from "../services/lenders/lenderReps.js";

const lender = randomUUID(); const other = randomUUID(); const company = randomUUID(); const app = randomUUID();
beforeAll(async () => {
  await rerunMigration(pool as any, readFileSync("migrations/2026_12_08_v960_lender_reps.sql", "utf8"));
  for (const [id, name] of [[lender, "Sample Lender One"], [other, "Sample Lender Two"]] as const) {
    await pool.query(`INSERT INTO lenders (id, name, country) VALUES ($1, $2, 'CA')`, [id, name]);
  }
  await pool.query(`INSERT INTO companies (id, name, lender_id, silo) VALUES ($1, 'Sample Lender One', $2, 'BF')`, [company, lender]);
  await pool.query(`INSERT INTO applications (id, name, pipeline_state, status, silo, created_at, updated_at) VALUES ($1, 'Sample Co', 'Received', 'RECEIVED', 'BF', now(), now())`, [app]);
  await pool.query(`INSERT INTO application_lender_selections (application_id, lender_id) VALUES ($1, $2), ($1, $3)`, [app, lender, other]);
});
afterAll(async () => {
  await pool.query(`DELETE FROM application_lender_reps WHERE application_id = $1`, [app]);
  await pool.query(`DELETE FROM lender_reps WHERE lender_id = ANY($1::uuid[])`, [[lender, other]]);
  await pool.query(`DELETE FROM application_lender_selections WHERE application_id = $1`, [app]);
  await pool.query(`DELETE FROM contacts WHERE company_id = $1`, [company]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [company]);
  await pool.query(`DELETE FROM applications WHERE id::text = $1`, [app]);
  await pool.query(`DELETE FROM lenders WHERE id = ANY($1::uuid[])`, [[lender, other]]);
});

describe("lender reps", () => {
  it("needs a name and an email, in plain words", () => {
    expect(parseRep({ name: "", email: "nope" })).toMatchObject({ ok: false, errors: { name: expect.any(String), email: expect.any(String) } });
  });

  it("keeps a rep under the lender and in the CRM, not as a marketing contact; the same email updates, never duplicates", async () => {
    const v = parseRep({ name: "Pat Sample", position: "Underwriter", email: "Pat.Sample@lender.example", phone: "403-555-0142" });
    if (!v.ok) throw new Error("form refused");
    const rep = await saveRep(lender, v.value, "tester");
    expect(rep).toMatchObject({ name: "Pat Sample", email: "pat.sample@lender.example", position: "Underwriter" });
    await saveRep(lender, { ...v.value, position: "Senior Underwriter" }, "tester");
    const reps = await listReps(lender);
    expect(reps).toHaveLength(1);
    expect(reps[0]!.position).toBe("Senior Underwriter");
    const c = await pool.query(`SELECT name, job_title, marketing_contact, lifecycle_stage FROM contacts WHERE company_id = $1`, [company]);
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0]).toMatchObject({ name: "Pat Sample", job_title: "Senior Underwriter", marketing_contact: false, lifecycle_stage: "lender" });
  });

  it("one rep per file and lender; a rep from another lender is refused; clearing goes back to no rep", async () => {
    const [rep] = await listReps(lender);
    expect(await repForFile(app, lender)).toBeNull();
    expect(await setRepForFile(app, other, rep!.id, "tester")).toBe("unknown_rep");
    expect(await setRepForFile(app, lender, rep!.id, "tester")).toBe("ok");
    expect(await repForFile(app, lender)).toMatchObject({ email: "pat.sample@lender.example" });
    const view = await fileLenderReps(app);
    expect(view.map((l) => l.lender_name)).toEqual(["Sample Lender One", "Sample Lender Two"]);
    expect(view[0]).toMatchObject({ rep_id: rep!.id, reps: [expect.objectContaining({ name: "Pat Sample" })] });
    expect(view[1]).toMatchObject({ rep_id: null, reps: [] });
    await setRepForFile(app, lender, null, "tester");
    expect(await repForFile(app, lender)).toBeNull();
  });
});
