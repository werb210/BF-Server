import jwt from "jsonwebtoken";
import request from "supertest";
import { buildAppWithApiRoutes } from "../src/app";
import { ROLES } from "../src/auth/roles";

const app = buildAppWithApiRoutes();

describe("cookie-based auth session", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = "test-access-secret";
  });

  function issueToken() {
    return jwt.sign(
      {
        sub: "user-cookie-1",
        role: ROLES.STAFF,
        tokenVersion: 0,
        silo: "BF",
      },
      process.env.JWT_SECRET ?? "test-access-secret",
      {
        expiresIn: "1h",
        issuer: "boreal-staff-server",
        audience: "boreal-staff-portal",
      }
    );
  }

  it("allows /api/auth/me when access token cookie exists", async () => {
    const token = issueToken();

    const res = await request(app)
      .get("/api/auth/me")
      .set("Cookie", [`token=${token}`]);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.userId).toBe("user-cookie-1");
    expect(res.body.role).toBe(ROLES.STAFF);
  });

  it("allows /api/telephony/token with cookie auth", async () => {
    const token = issueToken();

    const res = await request(app)
      .get("/api/telephony/token?identity=staff_portal")
      .set("Cookie", [`token=${token}`]);

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
  });
});
