// PIPELINE_NAME_FROM_APPLICATION - against a real Postgres: a file whose client typed the business name but had not
// submitted gets that name (it used to stay "Draft application", and the board hid it).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import { rerunMigration } from "./helpers/rerunMigration.js";

const named = randomUUID(); const empty = randomUUID(); const real = randomUUID();
beforeAll(async () => {
  const ins = (id: string, name: string, meta: unknown) => pool.query(
    `INSERT INTO applications (id, name, pipeline_state, status, silo, metadata, created_at, updated_at) VALUES ($1, $2, 'Received', 'RECEIVED', 'BF', $3::jsonb, now(), now())`, [id, name, JSON.stringify(meta)]);
  await ins(named, "Draft application", { business: { legalName: "  Sample Bakery Ltd. " } });
  await ins(empty, "Draft application", { business: { legalName: "   " } });
  await ins(real, "Kept Name Inc.", { business: { legalName: "Other Name" } });
  await rerunMigration(pool as any, readFileSync("migrations/2026_12_07_pipeline_names_from_application.sql", "utf8"));
});
afterAll(async () => { await pool.query(`DELETE FROM applications WHERE id::text = ANY($1::text[])`, [[named, empty, real]]); });
const nameOf = async (id: string) => (await pool.query(`SELECT name FROM applications WHERE id::text = $1`, [id])).rows[0]?.name;

describe("pipeline names from the application", () => {
  it("copies the typed business name over a placeholder", async () => { expect(await nameOf(named)).toBe("Sample Bakery Ltd."); });
  it("leaves a file with no business name alone", async () => { expect(await nameOf(empty)).toBe("Draft application"); });
  it("never replaces a real name", async () => { expect(await nameOf(real)).toBe("Kept Name Inc."); });
});
