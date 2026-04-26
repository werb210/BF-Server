import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: queryMock } };
});

describe("GET /api/users/me/o365-status", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret";
    process.env.MSAL_TENANT_ID = "tenant";
    process.env.MSAL_CLIENT_ID = "client";
    process.env.MSAL_CLIENT_SECRET = "secret";
    queryMock.mockReset();
    vi.restoreAllMocks();
  });

  function token() {
    return jwt.sign({
      id: "00000000-0000-0000-0000-000000000001",
      userId: "00000000-0000-0000-0000-000000000001",
      sub: "00000000-0000-0000-0000-000000000001",
      role: "admin",
    }, "test-secret");
  }

  async function app() {
    const router = (await import("../o365Tokens.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/users/me", router);
    return app;
  }

  it("returns connected false when no tokens", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE id = $1 LIMIT 1")) return { rows: [{ id: "00000000-0000-0000-0000-000000000001", role: "admin", silo: "BF", silos: ["BF"] }] };
      if (sql.includes("SELECT email, o365_account_id")) return { rows: [{ has_access: false, o365_refresh_token: null }] };
      return { rows: [] };
    });
    const res = await request(await app()).get("/api/users/me/o365-status").set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.reason).toBe("no_tokens");
  });

  it("returns connected true after silent refresh", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE id = $1 LIMIT 1")) return { rows: [{ id: "00000000-0000-0000-0000-000000000001", role: "admin", silo: "BF", silos: ["BF"] }] };
      if (sql.includes("SELECT email, o365_account_id")) return { rows: [{ email: "u@example.com", has_access: true, o365_refresh_token: "r1", o365_access_token_expires_at: new Date(Date.now() - 1_000).toISOString() }] };
      if (sql.includes("UPDATE users SET")) return { rows: [] };
      return { rows: [] };
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "new", refresh_token: "newr", expires_in: 3600 }),
    } as any));
    const res = await request(await app()).get("/api/users/me/o365-status").set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
  });

  it("returns 401 for bad JWT", async () => {
    const res = await request(await app()).get("/api/users/me/o365-status").set("Authorization", "Bearer invalid");
    expect(res.status).toBe(401);
  });

  it("returns 401 when JWT is missing", async () => {
    const res = await request(await app()).get("/api/users/me/o365-status");
    expect(res.status).toBe(401);
  });
});
