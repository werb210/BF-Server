// BF_AGENT_AUTH_HYDRATE_v53 — regression test. A service-style JWT minted
// with role:Staff and no capabilities array must clear the application:read
// capability gate after the auth middleware hydrates capabilities from role.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: queryMock } };
});

function token(role = "Staff"): string {
  const secret = process.env.JWT_SECRET as string;
  return jwt.sign({ id: "agent-service", phone: "agent", role }, secret, { expiresIn: "1h" });
}

async function buildApp() {
  const router = (await import("../modules/applications/applications.routes.js")).default;
  const { errorHandler } = await import("../middleware/errors.js");
  const a = express();
  a.use(express.json());
  a.use("/api/applications", router);
  a.use(errorHandler);
  return a;
}

describe("BF_AGENT_AUTH_HYDRATE_v53 agent JWT capability hydration", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    process.env.JWT_SECRET = "test-jwt-secret-minimum-10-chars";
  });

  it("Maya-style role-only Staff JWT clears application:read gate", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "app-1", silo: null, metadata: {} }] });

    const app = await buildApp();
    const res = await request(app)
      .get("/api/applications/app-1")
      .set("Authorization", `Bearer ${token("Staff")}`);

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("unknown role gets 403 (no hydration possible)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const app = await buildApp();
    const res = await request(app)
      .get("/api/applications/app-1")
      .set("Authorization", `Bearer ${token("NotARealRole")}`);
    expect(res.status).toBe(403);
  });
});
