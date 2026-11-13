// BF_SERVER_v955_REQUESTED_AFTER_DROP - a document staff ask for by hand stays on the list even when a rule
// removed that same document earlier (bank statements on a media file). Real Postgres.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { getRequestItemsForApp } from "../routes/clientDocumentsNeeded.js";
import { canonicalDocKey } from "../services/documentKinds.js";

const A = randomUUID();
const tag = A.slice(0, 8);
const bank = (list: Array<{ document_type: string }>) => list.filter((d) => canonicalDocKey(d.document_type) === "bank_statements");

describe("a hand-requested document survives the rule that dropped it", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM application_document_requests WHERE application_id::text = $1`, [A]);
    await pool.query(`DELETE FROM applications WHERE id::text = $1`, [A]);
  });

  it("media file: no bank statements by default, but they appear once staff request them", async () => {
    await pool.query(
      `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, product_category, metadata)
       VALUES ($1, $2, now(), now(), 'Received', 'RECEIVED', 'MEDIA', $3::jsonb)`,
      [A, `Media ${tag}`, JSON.stringify({ productRequirements: { aggregated: [{ category: "6 months business banking statements", required: true }] } })],
    );
    const before = await getRequestItemsForApp(A);
    expect(before.required.map((d) => d.document_type)).toContain("Budget");
    expect(bank(before.required)).toHaveLength(0);

    await pool.query(`INSERT INTO application_document_requests (application_id, document_type) VALUES ($1, $2)`, [A, "6 months business banking statements"]);
    const after = await getRequestItemsForApp(A);
    expect(bank(after.required)).toHaveLength(1);
    expect(bank(after.required)[0]!.required).toBe(true);
  });
});
