import request from "supertest";
import type { Express, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getTestApp } from "./setup";
import { requireAuthorization } from "../src/middleware/auth";

describe("Auth", () => {
  let app: Express;

  beforeAll(async () => {
    app = await getTestApp();
  });

  it("rejects unauthenticated", async () => {
    const res = await request(app).get("/api/leads");
    expect(res.status).toBe(401);
  });

  it("rejects invalid token", async () => {
    const res = await request(app)
      .get("/api/leads")
      .set("Authorization", "Bearer invalid");

    expect(res.status).toBe(401);
  });

  it("rejects expired token", async () => {
    const expiredToken = jwt.sign(
      {
        role: "admin",
        exp: Math.floor(Date.now() / 1000) - 3600,
      },
      process.env.JWT_SECRET ?? "test-secret",
      { subject: "expired-user" },
    );

    const res = await request(app)
      .get("/api/leads")
      .set("Authorization", `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
  });

  it("returns 403 when role is missing", () => {
    const middleware = requireAuthorization({ roles: ["admin"] });
    const req = { user: { role: "viewer" }, id: "req-1" } as unknown as Request;
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const res = { status, json } as unknown as Response;
    const next = vi.fn();

    middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when capability is missing", () => {
    const middleware = requireAuthorization({ capabilities: ["write"] });
    const req = { user: { role: "admin", capabilities: ["read"] }, id: "req-2" } as unknown as Request;
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const res = { status, json } as unknown as Response;
    const next = vi.fn();

    middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
