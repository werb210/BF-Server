import jwt from "jsonwebtoken";
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { ROLES } from "../auth/roles";

const app = buildAppWithApiRoutes();

const TOKEN_OPTIONS = {
  expiresIn: "1h",
  issuer: "boreal-staff-server",
  audience: "boreal-staff-portal",
};

describe("auth me contract", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = "test-access-secret";
  });

  it("accepts a valid JWT with role", async () => {
    const querySpy = vi.spyOn(pool, "query");
    const token = jwt.sign(
      { sub: "user-1", role: ROLES.STAFF, tokenVersion: 0 },
      process.env.JWT_SECRET ?? "test-access-secret",
      TOKEN_OPTIONS
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.userId).toBe("user-1");
    expect(res.body.role).toBe(ROLES.STAFF);
    expect(res.body.silo).toBe("BF");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(querySpy).toHaveBeenCalled();
    querySpy.mockRestore();
  });

  it("rejects a JWT without role", async () => {
    const querySpy = vi.spyOn(pool, "query");
    const token = jwt.sign(
      { sub: "user-2", tokenVersion: 0 },
      process.env.JWT_SECRET ?? "test-access-secret",
      TOKEN_OPTIONS
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(querySpy).not.toHaveBeenCalled();
    querySpy.mockRestore();
  });

  it("rejects requests without authorization", async () => {
    const querySpy = vi.spyOn(pool, "query");
    const res = await request(app).get("/api/auth/me");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_token");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(querySpy).not.toHaveBeenCalled();
    querySpy.mockRestore();
  });

  it("rejects invalid tokens", async () => {
    const querySpy = vi.spyOn(pool, "query");
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer garbage");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(querySpy).not.toHaveBeenCalled();
    querySpy.mockRestore();
  });
});
