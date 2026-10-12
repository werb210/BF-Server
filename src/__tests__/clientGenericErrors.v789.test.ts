// BF_SERVER_v789_GENERIC_ERRORS - the client signing endpoints returned the raw
// SignNow / internal error message to the browser. They now return a generic
// code and log the detail.
import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-min-10-chars";
const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECRET_DETAIL = "signnow 500 at https://internal.example/api key=abc123";

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = async (sql: string) => {
    const s = String(sql);
    if (s.includes("WITH app_phones AS")) return { rows: [{ total: 1, mine: 1, known: 1 }] };
    if (/FROM applications WHERE lower\(id::text\) = ANY/.test(s)) return { rows: [{ id: APP }] };
    if (s.includes("signnow_app_signed_at")) return { rows: [{ contact_id: null, signnow_app_signed_at: null, group_id: "g1" }] };
    return { rows: [] };
  };
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../signnow/signnowClient.js", () => ({
  getDocumentGroupStatus: async () => {
    throw new Error(SECRET_DETAIL);
  },
}));

describe("POST /api/client/signing-complete", () => {
  it("returns status_check_failed without the error detail, and logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { default: clientRouter } = await import("../routes/client/index.js");
    const app = express();
    app.use(express.json());
    app.use("/api/client", clientRouter);
    const tok = jwt.sign({ sub: "client:+15875550123", role: "client", phone: "+15875550123" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
    const r = await request(app).post(`/api/client/signing-complete?applicationId=${APP}`).set("Authorization", "Bearer " + tok).send({});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, signed: false, reason: "status_check_failed" });
    expect(JSON.stringify(r.body)).not.toContain("internal.example");
    expect(warn.mock.calls.some((c) => JSON.stringify(c).includes(SECRET_DETAIL))).toBe(true);
    warn.mockRestore();
  });
});
