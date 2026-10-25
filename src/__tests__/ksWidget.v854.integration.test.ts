// BF_SERVER_v854_KS_WIDGETS - the Keystone widget figures against real Postgres (baseline + migrations). The figures
// are counted inside one REPEATABLE READ transaction that is rolled back, so other suites writing Keystone rows at the
// same time cannot move the numbers, and nothing is left behind.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import widgetSummaryRoutes from "../routes/widgetSummary.js";
import { ksWidgetSummary, KS_WIDGET_NO_ACCESS } from "../modules/ks/ksWidget.js";

const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID();
const STAFF_KS = randomUUID();
const STAFF_BF = randomUUID();
const token = (role: string, id: string) => jwt.sign({ sub: id, id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));

function app() {
  const a = express();
  a.use("/api/widget", widgetSummaryRoutes);
  return a;
}

describe("v854 Keystone widget (real Postgres)", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO users (id, email, active, role, first_name, last_name, silo, silos) VALUES
         ($1, $2, true, 'Admin', 'Pat', 'Admin', 'BF', ARRAY['BF']),
         ($3, $4, true, 'Staff', 'Kim', 'Keystone', 'BF', ARRAY['BF','KS']),
         ($5, $6, true, 'Staff', 'Bo', 'Financial', 'BF', ARRAY['BF','BI'])`,
      [ADMIN, `ksw-admin-${tag}@example.com`, STAFF_KS, `ksw-ks-${tag}@example.com`, STAFF_BF, `ksw-bf-${tag}@example.com`],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ADMIN, STAFF_KS, STAFF_BF]])
      .catch((e) => console.warn("cleanup", String(e)));
  });

  it("counts open deals, paying licensees, demos with no follow-up, KS tasks, messages and what is next", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const before = await ksWidgetSummary(client, STAFF_KS);

      const co = { lead: randomUUID(), demoAlone: randomUUID(), demoFollowed: randomUUID(), paying: randomUUID(), lost: randomUUID(), bfPaying: randomUUID() };
      const insertCompany = (id: string, stage: string, silo = "KS") =>
        client.query(`INSERT INTO companies (id, name, silo, ks_stage) VALUES ($1, $2, $3, $4)`, [id, `KSW ${stage} ${tag}`, silo, stage]);
      await insertCompany(co.lead, "lead");
      await insertCompany(co.demoAlone, "demo_finished");
      await insertCompany(co.demoFollowed, "demo_finished");
      await insertCompany(co.paying, "paying");
      await insertCompany(co.lost, "lost");
      await insertCompany(co.bfPaying, "paying", "BF");

      const followedContact = randomUUID();
      const looseContact = randomUUID();
      const bfContact = randomUUID();
      await client.query(`INSERT INTO contacts (id, name, silo, company_id) VALUES ($1, 'Fran Followed', 'KS', $2)`, [followedContact, co.demoFollowed]);
      await client.query(`INSERT INTO contacts (id, name, silo, ks_stage) VALUES ($1, 'Lou Loose', 'KS', 'signed_up')`, [looseContact]);
      await client.query(`INSERT INTO contacts (id, name, silo) VALUES ($1, 'Bea BF', 'BF')`, [bfContact]);

      // An open task on the followed company's contact counts as follow-up; it is due tomorrow (not due, not overdue).
      await client.query(
        `INSERT INTO tasks (silo, title, assignee_user_id, contact_id, due_at) VALUES ('KS', $1, $2, $3, now() + interval '1 day')`,
        [`Follow up ${tag}`, STAFF_KS, followedContact],
      );
      // Overdue KS task: due and overdue, and the next task.
      await client.query(
        `INSERT INTO tasks (silo, title, assignee_user_id, contact_id, due_at) VALUES ('KS', $1, $2, $3, now() - interval '2 days')`,
        [`Overdue ${tag}`, STAFF_KS, looseContact],
      );
      // Not counted: completed, deleted, someone else's, and BF.
      await client.query(`INSERT INTO tasks (silo, title, assignee_user_id, due_at, status, completed_at) VALUES ('KS', 'done', $1, now() - interval '3 days', 'COMPLETED', now())`, [STAFF_KS]);
      await client.query(`INSERT INTO tasks (silo, title, assignee_user_id, due_at, deleted_at) VALUES ('KS', 'deleted', $1, now() - interval '3 days', now())`, [STAFF_KS]);
      await client.query(`INSERT INTO tasks (silo, title, assignee_user_id, due_at) VALUES ('KS', 'not mine', $1, now() - interval '3 days')`, [ADMIN]);
      await client.query(`INSERT INTO tasks (silo, title, assignee_user_id, due_at) VALUES ('BF', 'bf task', $1, now() - interval '3 days')`, [STAFF_KS]);

      // Unread inbound: one KS (counted), one BF and one read KS (not counted).
      await client.query(`INSERT INTO communications_messages (id, type, direction, contact_id, body, silo) VALUES ($1, 'sms', 'inbound', $2, 'hi', 'KS')`, [randomUUID(), looseContact]);
      await client.query(`INSERT INTO communications_messages (id, type, direction, contact_id, body, silo) VALUES ($1, 'sms', 'inbound', $2, 'hi', 'BF')`, [randomUUID(), bfContact]);
      await client.query(`INSERT INTO communications_messages (id, type, direction, contact_id, body, silo, read_at) VALUES ($1, 'sms', 'inbound', $2, 'read', 'KS', now())`, [randomUUID(), looseContact]);

      const bookingStart = new Date(Date.now() + 5 * 60_000);
      await client.query(
        `INSERT INTO booking_events (graph_event_id, silo, subject, scheduled_at, status) VALUES ($1, 'KS', $2, $3, 'ingested')`,
        [`ksw-${tag}`, `Keystone demo ${tag}`, bookingStart.toISOString()],
      );

      const after = await ksWidgetSummary(client, STAFF_KS);
      // Open = lead + the two finished demos + the loose signed-up contact; paying and lost are not open.
      expect(after.pipelineCount - before.pipelineCount).toBe(4);
      expect(after.payingLicensees - before.payingLicensees).toBe(1);
      expect(after.demosNeedFollowUp - before.demosNeedFollowUp).toBe(1);
      expect(after.tasksDueToday - before.tasksDueToday).toBe(1);
      expect(after.tasksOverdue - before.tasksOverdue).toBe(1);
      expect(after.unreadMessages - before.unreadMessages).toBe(1);
      expect(after.nextTask).toMatchObject({ title: `Overdue ${tag}`, contactName: "Lou Loose" });
      expect(after.nextMeeting).not.toBeNull();
      expect(Date.parse(after.nextMeeting!.start)).toBeLessThanOrEqual(bookingStart.getTime());
      if (!before.nextMeeting) expect(after.nextMeeting!.title).toBe(`Keystone demo ${tag}`);

      // Support tickets: a count once the v853 table exists, otherwise null.
      const hasTickets = (await client.query(`SELECT to_regclass('public.ks_support_tickets') IS NOT NULL AS present`)).rows[0].present;
      if (hasTickets) expect(typeof after.openSupportTickets).toBe("number");
      else expect(after.openSupportTickets).toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("serves the figures to Admins and KS staff, and an empty summary with the reason to everyone else", async () => {
    const admin = await request(app()).get("/api/widget/summary").set("X-Silo", "KS").set("Authorization", `Bearer ${token("Admin", ADMIN)}`);
    expect(admin.status).toBe(200);
    expect(admin.body).toMatchObject({ kind: "keystone", silo: "KS", available: true });
    expect(typeof admin.body.pipelineCount).toBe("number");

    const ks = await request(app()).get("/api/widget/summary").set("X-Silo", "KS").set("Authorization", `Bearer ${token("Staff", STAFF_KS)}`);
    expect(ks.body).toMatchObject({ kind: "keystone", available: true });

    const bf = await request(app()).get("/api/widget/summary").set("X-Silo", "KS").set("Authorization", `Bearer ${token("Staff", STAFF_BF)}`);
    expect(bf.status).toBe(200);
    expect(bf.body).toMatchObject({ kind: "keystone", silo: "KS", available: false, reason: KS_WIDGET_NO_ACCESS, pipelineCount: 0 });

    const bfOwn = await request(app()).get("/api/widget/summary").set("X-Silo", "BF").set("Authorization", `Bearer ${token("Staff", STAFF_BF)}`);
    expect(bfOwn.body.silo).toBe("BF");
    expect(bfOwn.body).not.toHaveProperty("kind");
  });
});
