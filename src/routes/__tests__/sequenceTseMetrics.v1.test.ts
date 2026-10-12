// BF_SERVER_SEQUENCE_TSE_METRICS_v1 - sequence email sends/opens/clicks come from the
// template_send_events ledger (via the sequence's step templates), not sequence_sends.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});

import marketing from "../marketing.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });

const LIST = /FROM marketing_sequences s WHERE s\.silo=\$1/;

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [LIST, { rows: [{ id: "seq-1", name: "Welcome", emails_sent: 1631, email_opens: 456, email_clicks: 30, sms_sent: 4 }] }],
  ]));
});

describe("sequence email metrics from template_send_events (v1)", () => {
  it("emails_sent/opens/clicks come from template_send_events via step templates", async () => {
    const r = await request(app).get("/api/marketing/sequences").set("Authorization", `Bearer ${token}`).set("X-Silo", "BI");
    expect(r.status).toBe(200);
    expect(r.body.data.items[0]).toMatchObject({ emails_sent: 1631, email_opens: 456, email_clicks: 30 });
    const [raw, params] = callsMatching(queryMock, LIST)[0] as [string, unknown[]];
    expect(params).toEqual(["BI"]);
    const sql = raw.replace(/\s+/g, " ");
    const ledger = "FROM template_send_events tse WHERE tse.channel='email' AND tse.silo=s.silo AND tse.template_id IN (SELECT st.template_id::text FROM marketing_sequence_steps st WHERE st.sequence_id=s.id AND st.template_id IS NOT NULL)";
    expect(sql).toContain(`(SELECT count(*)::int ${ledger}) AS emails_sent`);
    expect(sql).toContain(`(SELECT count(tse.opened_at)::int ${ledger}) AS email_opens`);
    expect(sql).toContain(`(SELECT count(tse.clicked_at)::int ${ledger}) AS email_clicks`);
    expect(sql).not.toContain("ss.channel='email'");
  });
});
