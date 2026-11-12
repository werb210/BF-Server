// BF_SERVER_v947_REMOVE_TERM_SHEET
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-min-10-chars";
const sqls: string[] = [];
let status: string | null = "pending";
let found = true;
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const runQuery = async (sql: string) => {
    sqls.push(sql);
    if (/from offers o\s+join applications a/i.test(sql)) return { rows: found ? [{ application_id: "A1", status }] : [], rowCount: found ? 1 : 0 };
    if (/delete from funding_conditions/i.test(sql)) return { rows: [], rowCount: 3 };
    return { rows: [], rowCount: 1 };
  };
  return { ...real, runQuery, dbQuery: runQuery, pool: { query: runQuery } };
});
import offersRouter from "../routes/offers.js";

const app = express();
app.use(express.json());
app.use("/api/offers", offersRouter);
const staff = "Bearer " + jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", userId: "11111111-1111-4111-8111-111111111111", role: "Staff" }, process.env.JWT_SECRET as string);

beforeEach(() => { sqls.length = 0; status = "pending"; found = true; });

describe("removing a term sheet from a file", () => {
  it("archives it and drops its untouched conditions", async () => {
    const r = await request(app).delete("/api/offers/o1").set("Authorization", staff);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ removed: true, conditions_removed: 3 });
    expect(sqls.some((s) => /update offers set is_archived = true/i.test(s))).toBe(true);
    const del = sqls.find((s) => /delete from funding_conditions/i.test(s))!;
    expect(del).toContain("status = 'open'");
    expect(del).toContain("client_submitted_at is null");
  });
  it("will not remove a signed term sheet", async () => {
    status = "accepted";
    const r = await request(app).delete("/api/offers/o1").set("Authorization", staff);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("offer_signed");
    expect(sqls.some((s) => /update offers set is_archived/i.test(s))).toBe(false);
  });
  it("404s for one that is not there, and needs a sign-in", async () => {
    found = false;
    expect((await request(app).delete("/api/offers/o1").set("Authorization", staff)).status).toBe(404);
    expect((await request(app).delete("/api/offers/o1")).status).toBe(401);
  });
});
