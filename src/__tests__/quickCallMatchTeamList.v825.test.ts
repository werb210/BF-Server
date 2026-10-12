// BF_SERVER_BLOCK_v825_QUICKCALL_MATCH_TEAM_LIST regression coverage
// The dialer's quick-call staff list must use the same filter as the Team list (listStaffUsers): active by
// is_active, not deleted, internal role. The legacy active/disabled columns must not hide anyone.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real = await orig<typeof import("../db.js")>();
  return { ...real, pool: { query: h.queryMock }, runQuery: h.queryMock };
});

import telephonyRouter from "../telephony/routes/telephonyRoutes.js";
import { listStaffUsers } from "../services/team/team.service.js";

const ME = "11111111-1111-4111-8111-111111111111";
const QUICK_SQL = /FROM users u\s+LEFT JOIN staff_presence sp/;
const TEAM_SQL = /SELECT id, first_name, last_name, email FROM users/;

const app = express();
app.use(express.json());
app.use("/api/telephony", telephonyRouter);
const staff = () => "Bearer " + jwt.sign({ sub: ME, role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string, { algorithm: "HS256" });

/** The WHERE predicates of a query, one per AND, with table aliases dropped. */
function predicates(sql: string): string[] {
  const where = sql.split(/\bWHERE\b/)[1].split(/\bORDER BY\b/)[0];
  return where.split(/\bAND\b/).map((p) => p.replace(/--.*$/gm, "").replace(/\bu\./g, "").replace(/\s+/g, " ").trim()).filter(Boolean);
}

beforeEach(() => {
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([
    [QUICK_SQL, { rows: [{ user_id: "u2", name: "Caden Staff", email: "caden@boreal.test", identity: "client:u2", profile_image_url: null, online: true }] }],
    [/quick_call_slots/, { rows: [{ slots: ["u2"] }] }],
    [TEAM_SQL, { rows: [{ id: "u2", first_name: "Caden", last_name: "Staff", email: "caden@boreal.test" }] }],
  ]));
});

describe("v825 quick-call staff filter", () => {
  it("serves the quick-call list to signed-in staff", async () => {
    expect((await request(app).get("/api/telephony/quick-call")).status).toBe(401);
    const r = await request(app).get("/api/telephony/quick-call").set("Authorization", staff());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ staff: [{ userId: "u2", name: "Caden Staff", identity: "client:u2", avatarUrl: null, online: true }], slots: ["u2"] });
    expect(callsMatching(h.queryMock, QUICK_SQL)[0][1]).toEqual([ME]);
  });

  it("uses the same active, deletion, and internal-role filter as listStaffUsers", async () => {
    await request(app).get("/api/telephony/quick-call").set("Authorization", staff());
    await listStaffUsers();
    const quick = predicates(sqlText(callsMatching(h.queryMock, QUICK_SQL)[0][0]));
    const team = predicates(sqlText(callsMatching(h.queryMock, TEAM_SQL)[0][0]));
    expect(team).toEqual(expect.arrayContaining([
      "COALESCE(is_active, true) = true",
      "deleted_at IS NULL",
      "role IN ('Admin', 'Staff', 'Ops', 'Marketing')",
    ]));
    for (const p of team) expect(quick).toContain(p);
    // The only extra condition is leaving the caller out of their own list.
    expect(quick.filter((p) => !team.includes(p))).toEqual(["id <> $1"]);
  });

  it("does not gate quick-call results on legacy active or disabled predicates", async () => {
    await request(app).get("/api/telephony/quick-call").set("Authorization", staff());
    const sql = sqlText(callsMatching(h.queryMock, QUICK_SQL)[0][0]).replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/coalesce\(u\.active/i);
    expect(sql).not.toMatch(/coalesce\(u\.disabled/i);
  });
});
