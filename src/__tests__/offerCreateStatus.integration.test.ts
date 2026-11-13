// The status a newly created offer is saved with must be one the offers table accepts (real Postgres).
// "Our term sheet" (no lender file) is created by POST /api/offers; it was saved as 'created', which the table's
// status check refuses, so saving our own term sheet always failed.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { NEW_OFFER_STATUS } from "../routes/offers.js";

const appId = randomUUID();
const offerIds: string[] = [];

describe("creating an offer", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM offers WHERE id::text = ANY($1::text[])`, [offerIds]);
    await pool.query(`DELETE FROM applications WHERE id::text = $1`, [appId]);
  });

  it("saves it with a status the table accepts", async () => {
    const status = NEW_OFFER_STATUS;
    await pool.query(
      `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, source, silo) VALUES ($1, 'Offer status test', now(), now(), 'Received', 'RECEIVED', 'client_direct', 'BF')`,
      [appId],
    );
    const id = randomUUID(); offerIds.push(id);
    await pool.query(
      `insert into offers (id, application_id, lender_name, amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at)
       values ($1,$2,'Our term sheet','600000','9.5','60 months','Monthly','2026-12-15',null,false,$3,null,now(),now())`,
      [id, appId, status],
    );
    const bad = randomUUID();
    await expect(pool.query(`insert into offers (id, application_id, lender_name, status) values ($1,$2,'x','created')`, [bad, appId])).rejects.toThrow(/offers_status_check/);
  });
});
