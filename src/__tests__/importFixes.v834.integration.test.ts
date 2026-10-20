// BF_SERVER_v834_IMPORT_FIXES - the package backfill and the OCR rule against the real schema.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { backfillPackagePrefill } from "../services/brokerImport/packageBackfill.js";
import { lockOcrJobs } from "../modules/ocr/ocr.repo.js";

const app = randomUUID();
const doc = randomUUID();
const tag = "v834" + Math.floor(Math.random() * 1e6);

describe("v834 import fixes against the real schema", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO applications (id, name, metadata, pipeline_state, status, source, created_at, updated_at)
       VALUES ($1, $2, '{"isDraft": true}'::jsonb, 'draft', 'RECEIVED', 'broker_import', now(), now())`,
      [app, `application ${app.replace(/-/g, " ")}`],
    );
    await pool.query(
      `INSERT INTO documents (id, application_id, category, document_type, status, filename, blob_name, created_at)
       VALUES ($1, $2, 'other', 'other', 'uploaded', 'application-fields.json', $3, now())`,
      [doc, app, `blob-${tag}`],
    );
  });
  afterAll(async () => {
    const clean = (sql: string, params: unknown[]) => pool.query(sql, params).catch((e) => console.warn("cleanup", String(e)));
    await clean("DELETE FROM documents WHERE id = $1", [doc]);
    await clean("DELETE FROM applications WHERE id = $1", [app]);
  });

  it("fills the file from application-fields.json once", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const storage = { get: vi.fn(async (name: string) => name === `blob-${tag}`
      ? { buffer: Buffer.from(JSON.stringify({ "company.legalName": `Grocer ${tag}`, "Requested Amount": 250000, "borrower.firstName": "Pat" })) }
      : null) };
    await backfillPackagePrefill({ storage });
    const r = await pool.query(`SELECT name, requested_amount, metadata FROM applications WHERE id = $1`, [app]);
    expect(r.rows[0].name).toBe(`Grocer ${tag}`);
    expect(Number(r.rows[0].requested_amount)).toBe(250000);
    expect(r.rows[0].metadata.broker_prefill.applicant.firstName).toBe("Pat");
    expect(r.rows[0].metadata.package_prefill_backfilled).toBeTruthy();
    storage.get.mockClear();
    await backfillPackagePrefill({ storage });
    expect(storage.get).not.toHaveBeenCalledWith(`blob-${tag}`); // once only
  });

  it("the OCR job query runs on the real schema", async () => {
    await expect(lockOcrJobs({ limit: 0, lockedBy: "test" })).resolves.toEqual([]);
  });
});
