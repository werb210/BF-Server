// BF_SERVER_DOC_SHARING_v635 - Todd's case: the client uploaded ID (and bank statements) on their
// capital application; staff then ask for ID on the equipment application for the same business,
// and a different business of the same client needs bank statements.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createApp } from "../app.js";
import { pool } from "../db.js";
import { deps } from "../system/deps.js";

const SECRET = process.env.JWT_SECRET || "ci-integration-secret-min-10";
const phone = "+15875550177";
const contactId = randomUUID();
const capital = randomUUID();
const equipment = randomUUID();
const otherBiz = randomUUID();
const staffToken = jwt.sign({ id: randomUUID(), sub: "00000000-0000-0000-0000-0000000000ab", role: "Admin" }, SECRET, { algorithm: "HS256" });
const clientToken = jwt.sign({ sub: "client:" + phone, role: "client", phone, tokenVersion: 0, isClient: true }, SECRET, { algorithm: "HS256" });
const BANK = "6 months business banking statements";
const reqMeta = JSON.stringify({ productRequirements: { aggregated: [{ document_type: BANK, required: true }] } });

async function addApp(id: string, name: string, meta: string) {
  await pool.query(
    "INSERT INTO applications (id, name, contact_id, silo, status, pipeline_state, metadata, created_at, updated_at) VALUES ($1, $2, $3, 'BF', 'RECEIVED', 'Received', $4::jsonb, now(), now())",
    [id, name, contactId, meta],
  );
}

describe("v635 documents follow the client", () => {
  const app = createApp();

  beforeAll(async () => {
    deps.db.ready = true;
    (deps.db as any).client = pool;
    // A database built from the schema snapshot has not run migrations newer than the snapshot;
    // production runs this file on startup. Apply it here the same way (it is idempotent).
    await pool.query(readFileSync("migrations/2026_09_28_v635_document_shares.sql", "utf8"));
    await pool.query("INSERT INTO contacts (id, name, phone, silo) VALUES ($1, 'Share Client', $2, 'BF')", [contactId, phone]);
    await addApp(capital, "Test - Todd's Gym", reqMeta);
    await addApp(equipment, "TEST TODDS GYM", reqMeta);
    await addApp(otherBiz, "Todd's Other Co", reqMeta);
    for (const [cat, type] of [["Government ID", "general"], [BANK, "bank_statement"]]) {
      await pool.query(
        "INSERT INTO documents (id, application_id, category, document_type, status, filename, storage_key, created_at) VALUES ($1, $2, $3, $4, 'accepted', 'f.pdf', 'blob/key', now())",
        [randomUUID(), capital, cat, type],
      );
    }
  });

  afterAll(async () => {
    const ids = [capital, equipment, otherBiz];
    await pool.query("DELETE FROM document_shares WHERE target_application_id = ANY($1::text[])", [ids]).catch(() => undefined);
    await pool.query("DELETE FROM communications_messages WHERE application_id::text = ANY($1::text[])", [ids]).catch(() => undefined);
    await pool.query("DELETE FROM application_document_requests WHERE application_id::text = ANY($1::text[])", [ids]).catch(() => undefined);
    await pool.query("DELETE FROM documents WHERE application_id::text = ANY($1::text[])", [ids]).catch(() => undefined);
    await pool.query("DELETE FROM applications WHERE id::text = ANY($1::text[])", [ids]).catch(() => undefined);
    await pool.query("DELETE FROM contacts WHERE id::text = $1", [contactId]).catch(() => undefined);
  });

  const todo = async (id: string) => {
    const r = await request(app).get("/api/client/documents-needed/action-center?applicationId=" + id).set("Authorization", "Bearer " + clientToken);
    expect(r.status).toBe(200);
    return (r.body.outstanding ?? r.body.data?.outstanding ?? []).map((i: any) => i.label) as string[];
  };

  it("same business: ID and bank statements come across; the client is asked for nothing", async () => {
    const res = await request(app).post("/api/applications/" + equipment + "/request-steps")
      .set("Authorization", "Bearer " + staffToken).send({ forms: [], documents: ["2 pieces of Government Issued ID"] });
    expect(res.status).toBe(200);
    expect(await todo(equipment)).toEqual([]);
    const shares = await pool.query("SELECT document_kind, source_application_id FROM document_shares WHERE target_application_id = $1 ORDER BY document_kind", [equipment]);
    expect(shares.rows).toEqual([
      { document_kind: "bank_statements", source_application_id: capital },
      { document_kind: "government_id", source_application_id: capital },
    ]);
  });

  it("staff Request Items shows them as uploaded, with where they came from", async () => {
    const r = await request(app).get("/api/portal/applications/" + equipment + "/request-items").set("Authorization", "Bearer " + staffToken);
    expect(r.status).toBe(200);
    const body = r.body.data ?? r.body;
    expect(body.satisfied).toEqual(expect.arrayContaining(["2 pieces of Government Issued ID", BANK]));
    expect(body.shared.map((s: any) => s.from_application_id)).toEqual([capital, capital]);
  });

  it("a different business gets the personal ID but must upload its own bank statements", async () => {
    await request(app).post("/api/applications/" + otherBiz + "/request-steps")
      .set("Authorization", "Bearer " + staffToken).send({ forms: [], documents: ["Government ID"] });
    expect(await todo(otherBiz)).toEqual([BANK]);
  });
});
