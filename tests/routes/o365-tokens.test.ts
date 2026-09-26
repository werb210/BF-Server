import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "../../src/db.js";
import o365TokensRouter from "../../src/routes/o365Tokens.js";
import { errorHandler } from "../../src/middleware/errors.js";

describe("O365 token endpoints", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret";
    vi.restoreAllMocks();
    vi.spyOn(pool, "query").mockImplementation(async (sql: string) => {
      if (sql.includes("o365_account_id")) {
        return {
          rows: [{
            email: "u@example.com",
            o365_account_id: "acct-1",
            // BF_SERVER_BLOCK_v578 - a token that expires this instant counts as expired (and there is
            // no refresh token here), so report a token valid for the next hour, as just stored.
            o365_access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            has_access: true,
            has_refresh: true,
          }],
        } as any;
      }
      return { rows: [] } as any;
    });
  });

  function app() {
    const a = express();
    a.use(express.json());
    a.use((req: any, _res, next) => {
      req.user = { id: "user-1", userId: "user-1" };
      next();
    });
    a.use("/api/users/me", o365TokensRouter);
    a.use(errorHandler);
    return a;
  }

  it("stores tokens and returns connected status", async () => {
    const token = jwt.sign({ id: "user-1", userId: "user-1", sub: "user-1", role: "admin" }, "test-secret");
    const postRes = await request(app())
      .post("/api/users/me/o365-tokens")
      .set("Authorization", `Bearer ${token}`)
      .send({ access_token: "access", refresh_token: "refresh", expires_in: 3600, account_id: "acct-1" });

    expect(postRes.status).toBe(200);
    expect(postRes.body.ok).toBe(true);

    const statusRes = await request(app())
      .get("/api/users/me/o365-status")
      .set("Authorization", `Bearer ${token}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.connected).toBe(true);
  });
});
