// BF_SERVER_REFERRER_SIGNUP_PROFILE_v1
// Signup captures the full profile, so the referrer it creates (or the pending one it updates) is marked
// profile_complete and lands on the dashboard, not the profile form.
import express from "express";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: h.queryMock } };
});
vi.mock("../../signnow/signnowClient.js", () => ({ isApiKeyConfigured: () => false }));

import referrerSelfRouter from "../referrerSelf.js";

const PENDING_ID = "66666666-6666-4666-8666-666666666666";
const app = express();
app.use(express.json());
app.use("/api/referrer", referrerSelfRouter);
const SIGNUP = { full_name: "Rae Ferrer", email: "rae@example.test", phone: "+15875550177", street: "2 Side St", city: "Edmonton", province: "AB", postal_code: "T5J 0A1", company_name: "Ferrer Co", etransfer_email: "pay@example.test" };
const EXISTING_SQL = /FROM users\s+WHERE role = \$1/;

beforeEach(() => {
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([]));
});

describe("referrer signup sets profile_complete", () => {
  it("INSERT includes profile_complete column and true value", async () => {
    const r = await request(app).post("/api/referrer/signup").send(SIGNUP);
    expect(r.status).toBe(200);
    const [ins] = callsMatching(h.queryMock, /INSERT INTO users/);
    const sql = sqlText(ins[0]);
    const cols = sql.match(/INSERT INTO users\s*\(([^)]*)\)/)![1].split(",").map((s) => s.trim());
    const vals = sql.match(/VALUES\s*\(([\s\S]*)\)\s*$/)![1].replace(/\bnow\(\)/g, "now").split(",").map((s) => s.trim());
    expect(vals[cols.indexOf("profile_complete")]).toBe("true");
    expect(vals[cols.indexOf("active")]).toBe("true");
    expect(ins[1]).toEqual([r.body.data.referrerId, "Rae", "Ferrer", "rae@example.test", "+15875550177", "Ferrer Co",
      "2 Side St", "Edmonton", "AB", "T5J 0A1", "pay@example.test", "Referrer"]);
  });

  it("UPDATE sets profile_complete=true", async () => {
    h.queryMock.mockImplementation(answerBySql([
      [EXISTING_SQL, { rows: [{ id: PENDING_ID, referrer_status: "pending_agreement", agreement_document_group_id: null }] }],
    ]));
    const r = await request(app).post("/api/referrer/signup").send(SIGNUP);
    expect(r.status).toBe(200);
    expect(r.body.data.referrerId).toBe(PENDING_ID);
    expect(callsMatching(h.queryMock, /INSERT INTO users/)).toHaveLength(0);
    const [upd] = callsMatching(h.queryMock, /UPDATE users SET first_name=\$2/);
    expect(sqlText(upd[0])).toContain("profile_complete=true, updated_at=now()");
    expect(upd[1]).toEqual([PENDING_ID, "Rae", "Ferrer", "rae@example.test", "Ferrer Co", "2 Side St", "Edmonton", "AB", "T5J 0A1", "pay@example.test"]);
  });

  it("an already active referrer is told to log in and nothing is written", async () => {
    h.queryMock.mockImplementation(answerBySql([
      [EXISTING_SQL, { rows: [{ id: PENDING_ID, referrer_status: "active", agreement_document_group_id: "g" }] }],
    ]));
    const r = await request(app).post("/api/referrer/signup").send(SIGNUP);
    expect(r.body.data).toEqual({ alreadyActive: true });
    expect(callsMatching(h.queryMock, /INSERT INTO users|UPDATE users/)).toHaveLength(0);
  });
});
