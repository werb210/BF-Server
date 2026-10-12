// BF_SERVER_SENDGRID_DIAGNOSTICS_v1 - the admin "test SendGrid now" endpoint
// reports config state and, given a `to`, returns SendGrid's exact status +
// a plain-language diagnosis (401=bad key, 403=sender not verified).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const h = vi.hoisted(() => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })), sendOne: vi.fn() }));
vi.mock("../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: h.query, connect: vi.fn() }, runQuery: h.query, dbQuery: h.query }));
vi.mock("../services/sendgridService.js", async (orig) => ({
  ...(await orig() as any),
  sendgridConfigured: () => Boolean(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM),
  sendOne: (...a: unknown[]) => h.sendOne(...a),
}));
import adminRouter from "../routes/admin.js";

const sign = (role: string) => "Bearer " + jwt.sign({ sub: "72727272-7272-4272-8272-727272727272", role, tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
const app = express();
app.use(express.json());
app.use("/api/admin", adminRouter);
const diag = (body: Record<string, unknown> = {}, role = "Admin") =>
  request(app).post("/api/admin/sendgrid-diagnostics").set("Authorization", sign(role)).send(body);

beforeEach(() => {
  vi.stubEnv("SENDGRID_API_KEY", "SG.very-secret-key-value");
  vi.stubEnv("SENDGRID_FROM", "noreply@boreal.financial");
  h.sendOne.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("sendgrid diagnostics endpoint", () => {
  it("is registered and admin-guarded", async () => {
    expect((await diag()).status).toBe(200);
    expect((await diag({}, "Staff")).status).toBe(403);
    expect((await request(app).post("/api/admin/sendgrid-diagnostics")).status).toBe(401);
  });

  it("reports config state without leaking the full key", async () => {
    const r = await diag();
    expect(r.body).toMatchObject({ configured: true, keySet: true, fromSet: true, keyPrefix: "SG.", keyLooksValid: true, tested: false });
    expect(JSON.stringify(r.body)).not.toContain("very-secret");
    vi.stubEnv("SENDGRID_API_KEY", "xx-not-a-sendgrid-key");
    expect((await diag()).body).toMatchObject({ keyPrefix: "xx-", keyLooksValid: false });
    vi.stubEnv("SENDGRID_FROM", "");
    expect((await diag({ to: "ops@boreal.financial" })).body).toMatchObject({ fromSet: false, tested: false, error: "not_configured" });
    expect(h.sendOne).not.toHaveBeenCalled();
  });

  it("does a real send and maps status to a plain diagnosis", async () => {
    h.sendOne.mockResolvedValueOnce({ ok: false, status: 401, error: "unauthorized" });
    expect((await diag({ to: "ops@boreal.financial" })).body).toMatchObject({ tested: true, sendStatus: 401, ok: false, diagnosis: "api_key_invalid" });
    h.sendOne.mockResolvedValueOnce({ ok: false, status: 403, error: "forbidden" });
    expect((await diag({ to: "ops@boreal.financial" })).body).toMatchObject({ sendStatus: 403, diagnosis: "sender_not_verified_or_forbidden" });
    h.sendOne.mockResolvedValueOnce({ ok: false, status: 429 });
    expect((await diag({ to: "ops@boreal.financial" })).body).toMatchObject({ sendStatus: 429, diagnosis: "sendgrid_error_429" });
    h.sendOne.mockResolvedValueOnce({ ok: true, status: 202 });
    expect((await diag({ to: "ops@boreal.financial" })).body).toMatchObject({ sendStatus: 202, ok: true, diagnosis: "ok" });
    expect(h.sendOne).toHaveBeenLastCalledWith(expect.objectContaining({ to: "ops@boreal.financial" }));
  });
});
