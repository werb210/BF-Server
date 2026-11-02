// BF_SERVER_v865_BROKER_TOOLS - the broker tools against real Postgres: migrations (twice), and the API flows of each tool.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import portalRoutes from "../routes/portal.js";
import brokerToolsRoutes from "../routes/brokerTools.js";
import clientBrokerRoutes from "../routes/clientBroker.js";
import { markReady } from "../startupState.js";
import { deps } from "../system/deps.js";
import { rateOn } from "../brokerTools/salesTax.js";

const MIGRATIONS = readdirSync("migrations").filter((f) => f.includes("_broker_tools_")).sort().map((f) => `migrations/${f}`);
const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID(), STAFF = randomUUID();
const contactId = randomUUID(), appId = randomUUID();
const phone = "+1780555" + String(Math.floor(1000 + Math.random() * 8999));
const tok = (id: string, role: string) => `Bearer ${jwt.sign({ sub: id, id, userId: id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET))}`;
const clientTok = `Bearer ${jwt.sign({ phone, role: "client" }, String(process.env.JWT_SECRET))}`;

export function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/portal", portalRoutes);
  a.use("/api/broker-tools", brokerToolsRoutes);
  a.use("/api/client-broker", clientBrokerRoutes);
  return a;
}
const http = () => request(app());


describe("broker tools (real Postgres)", () => {
  beforeAll(async () => {
    markReady();
    deps.db.client = pool;
    deps.db.ready = true;
    for (const m of MIGRATIONS) await pool.query(readFileSync(m, "utf8"));
    for (const m of MIGRATIONS) await pool.query(readFileSync(m, "utf8")); // safe to run again
    for (const [id, role, first] of [[ADMIN, "Admin", "Ada"], [STAFF, "Staff", "Sam"]]) {
      await pool.query(`INSERT INTO users (id, email, active, role, first_name, last_name) VALUES ($1, $2, true, $3, $4, 'Broker')`, [id, `${first.toLowerCase()}-${tag}@example.com`, role, first]);
    }
    await pool.query(`INSERT INTO contacts (id, name, email, phone, silo) VALUES ($1, $2, $3, $4, 'BF')`, [contactId, `Client ${tag}`, `client-${tag}@example.com`, phone]);
    await pool.query(
      `INSERT INTO applications (id, name, pipeline_state, created_at, updated_at, silo, contact_id, requested_amount, owner_user_id, metadata, status)
       VALUES ($1, $2, 'Accepted', now(), now(), 'BF', $3, 85000, $4, '{}'::jsonb, 'ACCEPTED')`,
      [appId, `Equipment ${tag}`, contactId, STAFF],
    );
    await pool.query(`INSERT INTO offers (id, application_id, lender_name, amount, status, notes) VALUES ($1, $2, 'Test Lender', 85000, 'accepted', $3)`,
      [randomUUID(), appId, "Conditions:\n- Void cheque\n- Insurance certificate naming the lender"]);
  }, 120_000);

  afterAll(async () => {
    await pool.query(`DELETE FROM funding_conditions WHERE application_id = $1`, [appId]);
    await pool.query(`DELETE FROM offers WHERE application_id = $1`, [appId]);
    await pool.query(`DELETE FROM application_stage_events WHERE application_id::text = $1`, [appId]).catch((e) => console.warn("cleanup", e.message));
    await pool.query(`DELETE FROM applications WHERE id = $1`, [appId]).catch((e) => console.warn("cleanup", e.message));
    await pool.query(`DELETE FROM contacts WHERE id = $1`, [contactId]).catch((e) => console.warn("cleanup", e.message));
  });

  describe("1 funding conditions", () => {
    it("imports the offer's conditions, adds a client item and blocks Funded until cleared", async () => {
      const base = `/api/broker-tools/applications/${appId}/conditions`;
      const imp = await http().post(`${base}/from-offer`).set("Authorization", tok(STAFF, "Staff"));
      expect(imp.status).toBe(200);
      expect(imp.body.added).toBe(2);
      const again = await http().post(`${base}/from-offer`).set("Authorization", tok(STAFF, "Staff"));
      expect(again.body.added).toBe(0);
      const add = await http().post(base).set("Authorization", tok(STAFF, "Staff")).send({ title: "Signed delivery receipt", owner: "client", due_date: "2026-12-01" });
      expect(add.status).toBe(201);

      const blocked = await http().patch(`/api/portal/applications/${appId}/status`).set("Authorization", tok(STAFF, "Staff")).send({ status: "Funded" });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toBe("funding_conditions_outstanding");
      expect(blocked.body.outstanding).toHaveLength(3);
      expect(blocked.body.can_override).toBe(false);

      // The client sees only their own item and marks it done.
      const mine = await http().get(`/api/client-broker/conditions?applicationId=${appId}`).set("Authorization", clientTok);
      expect(mine.status).toBe(200);
      expect(mine.body.conditions.map((c: any) => c.title)).toEqual(["Signed delivery receipt"]);
      const done = await http().post(`/api/client-broker/conditions/${add.body.condition.id}/done`).set("Authorization", clientTok).send({ applicationId: appId });
      expect(done.status).toBe(200);
      const other = await http().get(`/api/client-broker/conditions?applicationId=${appId}`).set("Authorization", `Bearer ${jwt.sign({ phone: "+17805550000" }, String(process.env.JWT_SECRET))}`);
      expect(other.status).toBe(403);

      const list = (await http().get(base).set("Authorization", tok(STAFF, "Staff"))).body.conditions as any[];
      const waive = await http().patch(`${base}/${list[0].id}`).set("Authorization", tok(STAFF, "Staff")).send({ status: "waived" });
      expect(waive.status).toBe(400);
      for (const c of list) {
        const r = await http().patch(`${base}/${c.id}`).set("Authorization", tok(STAFF, "Staff")).send(c.owner === "client" ? { status: "cleared" } : { status: "waived", waived_reason: "Lender confirmed by email" });
        expect(r.status).toBe(200);
      }
      const funded = await http().patch(`/api/portal/applications/${appId}/status`).set("Authorization", tok(STAFF, "Staff")).send({ status: "Funded" });
      expect(funded.status).toBe(200);
      const app = (await pool.query(`SELECT pipeline_state, funded_at FROM applications WHERE id = $1`, [appId])).rows[0];
      expect(app.pipeline_state).toBe("Funded");
      expect(app.funded_at).not.toBeNull();
      const audit = await pool.query(`SELECT 1 FROM audit_events WHERE target_id = $1 AND event_action = 'funding_conditions.cleared_to_fund'`, [appId]);
      expect(audit.rows.length).toBe(1);
    });

    it("lets an Admin override with a reason, and audits it", async () => {
      const other = randomUUID();
      await pool.query(`INSERT INTO applications (id, name, pipeline_state, created_at, updated_at, silo, owner_user_id, status) VALUES ($1, 'Override ${tag}', 'Accepted', now(), now(), 'BF', $2, 'ACCEPTED')`, [other, STAFF]);
      try {
        await http().post(`/api/broker-tools/applications/${other}/conditions`).set("Authorization", tok(ADMIN, "Admin")).send({ title: "PPSA search" });
        const r1 = await http().patch(`/api/portal/applications/${other}/status`).set("Authorization", tok(ADMIN, "Admin")).send({ status: "Funded" });
        expect(r1.status).toBe(409);
        expect(r1.body.can_override).toBe(true);
        const r2 = await http().patch(`/api/portal/applications/${other}/status`).set("Authorization", tok(ADMIN, "Admin")).send({ status: "Funded", override_reason: "Lender waived PPSA by phone" });
        expect(r2.status).toBe(200);
        const a = await pool.query(`SELECT metadata FROM audit_events WHERE target_id = $1 AND event_action = 'funding_conditions.override'`, [other]);
        expect(a.rows[0].metadata.reason).toBe("Lender waived PPSA by phone");
      } finally {
        await pool.query(`DELETE FROM funding_conditions WHERE application_id = $1`, [other]);
        await pool.query(`DELETE FROM applications WHERE id = $1`, [other]).catch((e) => console.warn("cleanup", e.message));
      }
    });

    it("hides another silo's application", async () => {
      const r = await http().get(`/api/broker-tools/applications/${randomUUID()}/conditions`).set("Authorization", tok(STAFF, "Staff"));
      expect(r.status).toBe(404);
    });
  });

  // BF_SERVER_v865_BROKER_TOOLS_3_SALES_TAX
  describe("3 sales tax", () => {
    it("serves the seeded rates, calculates, and only an Admin edits; a dated row applies from its day", async () => {
      const list = await http().get("/api/broker-tools/sales-tax/rates").set("Authorization", tok(STAFF, "Staff"));
      expect(list.status).toBe(200);
      const on = list.body.current.find((r: any) => r.province === "ON");
      expect(on.hst).toBe(13);
      expect(list.body.current.find((r: any) => r.province === "QC").combined).toBe(14.975);
      const calc = await http().post("/api/broker-tools/sales-tax/calculate").set("Authorization", tok(STAFF, "Staff")).send({ amount: 1000, province: "British Columbia" });
      expect(calc.body.lines).toEqual([{ label: "GST 5%", amount: 50 }, { label: "PST 7%", amount: 70 }]);
      expect(calc.body.total_with_tax).toBe(1120);
      const bad = await http().post("/api/broker-tools/sales-tax/calculate").set("Authorization", tok(STAFF, "Staff")).send({ amount: 1000, province: "Texas" });
      expect(bad.status).toBe(400);

      const edit = { province: "ON", effective_from: "2099-01-01", hst: 14, note: "test" };
      expect((await http().put("/api/broker-tools/sales-tax/rates").set("Authorization", tok(STAFF, "Staff")).send(edit)).status).toBe(403);
      expect((await http().put("/api/broker-tools/sales-tax/rates").set("Authorization", tok(ADMIN, "Admin")).send({ ...edit, gst: 5 })).status).toBe(400);
      try {
        expect((await http().put("/api/broker-tools/sales-tax/rates").set("Authorization", tok(ADMIN, "Admin")).send(edit)).status).toBe(200);
        expect((await rateOn(pool as any, "ON", "2099-02-01")).hst).toBe(14);
        expect((await rateOn(pool as any, "ON", "2026-11-01")).hst).toBe(13);
      } finally {
        expect((await http().delete("/api/broker-tools/sales-tax/rates/ON/2099-01-01").set("Authorization", tok(ADMIN, "Admin"))).status).toBe(200);
      }
    });

  });
});
