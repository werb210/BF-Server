// BF_SERVER_CHAT_IS_CHAT_v629 - reproduces Todd's test: an application submitted with banking
// outstanding, banking then uploaded, then staff request two pieces of government ID. The chat
// must hold conversation only (no task prompts, nothing about banking); the ID must be listed
// in "What you need to do" (action center) exactly as staff typed it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { pool } from "../db.js";
import { deps } from "../system/deps.js";

const SECRET = process.env.JWT_SECRET || "ci-integration-secret-min-10";
const phone = "+15875550142";
const appId = randomUUID();
const contactId = randomUUID();
const staffToken = jwt.sign({ id: randomUUID(), sub: "00000000-0000-0000-0000-0000000000aa", role: "Admin" }, SECRET, { algorithm: "HS256" });
const clientToken = jwt.sign({ sub: "client:" + phone, role: "client", phone, tokenVersion: 0, isClient: true }, SECRET, { algorithm: "HS256" });
const BANKING = "6 months business banking statements";

describe("v629 chat is chat", () => {
  const app = createApp();

  beforeAll(async () => {
    deps.db.ready = true;
    (deps.db as any).client = pool;
    await pool.query("INSERT INTO contacts (id, name, phone, silo) VALUES ($1, 'Test Client', $2, 'BF')", [contactId, phone]);
    await pool.query(
      "INSERT INTO applications (id, name, contact_id, silo, status, pipeline_state, metadata, created_at, updated_at) VALUES ($1, 'Test App', $2, 'BF', 'RECEIVED', 'Received', $3::jsonb, now(), now())",
      [appId, contactId, JSON.stringify({ productRequirements: { aggregated: [{ document_type: BANKING, required: true }] } })],
    );
    // What submit posted while banking was still missing.
    await pool.query(
      "INSERT INTO communications_messages (id, type, direction, status, application_id, contact_id, silo, body, staff_name, cta_label, cta_action, created_at) VALUES (gen_random_uuid(), 'message', 'outbound', 'sent', $1, $2, 'BF', $3, 'Boreal Financial', 'Upload documents', 'upload_docs', now() - interval '1 day')",
      [appId, contactId, "To continue your application, please upload your supporting documents: " + BANKING + "."],
    );
    // Banking has since been uploaded.
    await pool.query("INSERT INTO documents (id, application_id, category, document_type, status, created_at) VALUES (gen_random_uuid(), $1, $2, $2, 'accepted', now())", [appId, BANKING]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM communications_messages WHERE application_id::text = $1", [appId]).catch(() => undefined);
    await pool.query("DELETE FROM application_document_requests WHERE application_id::text = $1", [appId]).catch(() => undefined);
    await pool.query("DELETE FROM documents WHERE application_id::text = $1", [appId]).catch(() => undefined);
    await pool.query("DELETE FROM applications WHERE id::text = $1", [appId]).catch(() => undefined);
    await pool.query("DELETE FROM contacts WHERE id::text = $1", [contactId]).catch(() => undefined);
  });

  const thread = async () => {
    const res = await request(app).get("/api/client/messages?applicationId=" + appId).set("Authorization", "Bearer " + clientToken);
    expect(res.status).toBe(200);
    return res.body.data as Array<{ body: string; cta_action: string | null }>;
  };

  it("keeps the chat to conversation while nothing is outstanding", async () => {
    const rows = await thread();
    expect(rows.some((r) => r.cta_action === "upload_docs")).toBe(false);
  });

  it("after staff request ID: chat has no task prompts, the to-do panel lists the ID", async () => {
    const res = await request(app)
      .post("/api/applications/" + appId + "/request-steps")
      .set("Authorization", "Bearer " + staffToken)
      .send({ forms: [], documents: ["2 pieces of Government Issued ID"] });
    expect(res.status).toBe(200);
    await pool.query(
      "INSERT INTO communications_messages (id, type, direction, status, application_id, contact_id, silo, body, staff_name, created_at) VALUES (gen_random_uuid(), 'message', 'outbound', 'sent', $1, $2, 'BF', 'Hi Todd, just checking in.', 'Todd', now())",
      [appId, contactId],
    );
    const rows = await thread();
    expect(rows.some((r) => r.cta_action)).toBe(false);
    expect(rows.some((r) => /banking|added more documents|please upload/i.test(r.body))).toBe(false);
    expect(rows.some((r) => r.body === "Hi Todd, just checking in.")).toBe(true);
    const ac = await request(app)
      .get("/api/client/documents-needed/action-center?applicationId=" + appId)
      .set("Authorization", "Bearer " + clientToken);
    expect(ac.status).toBe(200);
    const labels = (ac.body.outstanding ?? ac.body.data?.outstanding ?? []).map((i: any) => i.label);
    expect(labels).toEqual(["2 pieces of Government Issued ID"]);
  });
});
