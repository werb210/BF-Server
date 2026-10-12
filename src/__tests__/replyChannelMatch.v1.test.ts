// BF_SERVER_REPLY_CHANNEL_MATCH_v1 - the template "replies" metric must only
// count inbound messages whose channel matches the template's send channel.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});

import marketing from "../routes/marketing.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });

const ANALYTICS = /FROM marketing_template t/;
async function runAnalytics(silo = "BF") {
  const r = await request(app).get("/api/marketing/templates/analytics").set("Authorization", `Bearer ${token}`).set("X-Silo", silo);
  const [sql, params] = callsMatching(queryMock, ANALYTICS)[0] as [string, unknown[]];
  return { r, sql: sql.replace(/\s+/g, " "), params };
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [ANALYTICS, { rows: [{ id: "t1", channel: "email", name: "Blast", sends: 10, opens: 4, clicks: 2, replies: 1 }] }],
  ]));
});

describe("template replies channel match v1", () => {
  it("returns the per-template metrics the query produces", async () => {
    const { r } = await runAnalytics();
    expect(r.status).toBe(200);
    expect(r.body.data.items).toEqual([{ id: "t1", channel: "email", name: "Blast", sends: 10, opens: 4, clicks: 2, replies: 1 }]);
  });

  it("the reply attribution pulls the channel of the last template sent", async () => {
    const { sql } = await runAnalytics();
    expect(sql).toMatch(/JOIN LATERAL \( SELECT e\.template_id, e\.channel FROM template_send_events e/);
  });

  it("counts an inbound message only when its channel matches the template channel", async () => {
    const { sql } = await runAnalytics();
    expect(sql).toContain("m.direction = 'inbound'");
    expect(sql).toContain("AND m.type = tse.channel");
  });

  it("is silo scoped", async () => {
    const { params, sql } = await runAnalytics("BI");
    expect(params).toEqual(["BI"]);
    expect(sql).toContain("m.silo = $1");
    expect(sql).toContain("WHERE t.silo = $1");
  });
});
