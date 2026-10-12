// BF_SERVER_REFERRER_SIGNUP_FIX_v1
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: h.queryMock } };
});
vi.mock("../../signnow/signnowClient.js", () => ({ isApiKeyConfigured: () => false }));

import referrerSelfRouter from "../referrerSelf.js";

const app = express();
app.use(express.json());
app.use("/api/referrer", referrerSelfRouter);
const SIGNUP = { full_name: "Rae Ferrer", email: "rae@example.test", phone: "+15875550177", street: "2 Side St", city: "Edmonton", province: "AB", postal_code: "T5J 0A1" };
const signup = () => request(app).post("/api/referrer/signup").send(SIGNUP);

function insertMapping(sql: string): Record<string, string> {
  const m = sql.match(/INSERT INTO users\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*$/);
  if (!m) throw new Error("not a users INSERT: " + sql);
  const cols = m[1].split(",").map((s) => s.trim());
  const vals = m[2].replace(/\bnow\(\)/g, "now").split(",").map((s) => s.trim());
  expect(vals).toHaveLength(cols.length);
  return Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
}

// users_status_check, as the database enforces it.
const USERS_STATUS = new Set(["ACTIVE", "INACTIVE", "DISABLED", "PENDING"]);
const enforceStatusCheck = (sql: string) => {
  const status = insertMapping(sql).status?.replace(/'/g, "");
  if (!USERS_STATUS.has(status)) {
    throw Object.assign(new Error('new row violates check constraint "users_status_check"'), { code: "23514" });
  }
  return { rows: [], rowCount: 1 };
};

beforeEach(() => {
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([[/INSERT INTO users/, enforceStatusCheck]]));
});
afterEach(() => vi.restoreAllMocks());

describe("referrer signup fix", () => {
  it("inserts status ACTIVE (uppercase) to satisfy users_status_check", async () => {
    const r = await signup();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ agreementConfigured: false });
    const [ins] = callsMatching(h.queryMock, /INSERT INTO users/);
    const map = insertMapping(sqlText(ins[0]));
    expect(map.status).toBe("'ACTIVE'");
    expect(map.referrer_status).toBe("'pending_agreement'");
    expect(sqlText(ins[0])).not.toContain("'active', now(), now())");
  });

  it("returns 409 already_registered on a unique violation, not a 500", async () => {
    h.queryMock.mockImplementation(answerBySql([
      [/INSERT INTO users/, Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { code: "23505" })],
    ]));
    const r = await signup();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ status: "error", error: "already_registered" });
    expect(callsMatching(h.queryMock, /INSERT INTO contacts/)).toHaveLength(0);
  });

  it("any other insert failure is still an error, not a silent success", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.queryMock.mockImplementation(answerBySql([[/INSERT INTO users/, Object.assign(new Error("connection reset"), { code: "08006" })]]));
    const r = await signup();
    expect(r.status).toBeGreaterThanOrEqual(500);
  });
});
