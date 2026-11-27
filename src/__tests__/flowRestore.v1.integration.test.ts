// BF_SERVER_FLOW_RESTORE_v1 - a deleted flow keeps its emails and people and can be brought back, paused.
import { afterAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { pool } from "../db.js";
import flowRoutes from "../flows/flowRoutes.js";

const ids: string[] = [];
function app(role = "admin") {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { (req as any).user = { role }; req.headers["x-silo"] = "KS"; next(); });
  a.use("/api/crm/flows", flowRoutes);
  return a;
}
async function flow(started: boolean) {
  const r = await pool.query(
    `INSERT INTO crm_flows (silo, name, audience_tags, market, status, started_at, emails) VALUES ('KS', $1, ARRAY['broker'], 'CA', 'archived', $2, '{"e1":{"subject":"Hi","body":"Kept"}}'::jsonb) RETURNING id`,
    [`restore-test-${Date.now()}-${started}`, started ? new Date() : null]);
  ids.push(r.rows[0].id);
  return r.rows[0].id as string;
}

describe("restoring a deleted flow", () => {
  afterAll(async () => { await pool.query(`DELETE FROM crm_flows WHERE id = ANY($1::uuid[])`, [ids]); });

  it("lists deleted flows and brings one back paused, with its emails", async () => {
    const id = await flow(true);
    const list = await request(app()).get("/api/crm/flows/deleted/list").expect(200);
    expect(list.body.flows.map((f: any) => f.id)).toContain(id);
    expect((await request(app()).get(`/api/crm/flows/${id}`)).status).toBe(404);
    const r = await request(app()).post(`/api/crm/flows/${id}/restore`).expect(200);
    expect(r.body.status).toBe("paused");
    const got = await request(app()).get(`/api/crm/flows/${id}`).expect(200);
    expect(got.body.emails.find((e: any) => e.key === "e1").body).toBe("Kept");
    expect((await request(app()).post(`/api/crm/flows/${id}/restore`)).status).toBe(404);
  });

  it("a flow that never started comes back as a draft; staff cannot restore", async () => {
    const id = await flow(false);
    expect((await request(app("staff")).post(`/api/crm/flows/${id}/restore`)).status).toBe(403);
    expect((await request(app()).post(`/api/crm/flows/${id}/restore`).expect(200)).body.status).toBe("draft");
  });
});
