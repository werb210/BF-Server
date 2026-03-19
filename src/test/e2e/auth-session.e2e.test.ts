import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES } from "../../auth/roles";
import { createTestServer } from "../../server/testServer";
import { seedUser } from "../helpers/users";

let server: Awaited<ReturnType<typeof createTestServer>>;
let phoneCounter = 6000;

const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

describe("auth session cookie flow", () => {
  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("persists auth via session cookie after otp verify", async () => {
    const phone = nextPhone();
    await seedUser({
      phoneNumber: phone,
      role: ROLES.STAFF,
      email: `session-${phone.replace(/\D/g, "")}@example.com`,
    });
    const agent = request.agent(server.url);

    const startRes = await agent.post("/api/auth/otp/start").send({ phone });
    expect(startRes.status).toBe(200);

    const verifyRes = await agent.post("/api/auth/otp/verify").send({
      phone,
      code: "123456",
    });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.headers["set-cookie"]?.join(";") ?? "").toContain("session=");

    const meRes = await agent.get("/api/auth/me");
    expect(meRes.status).toBe(200);
    expect(meRes.body.ok).toBe(true);
    expect(typeof meRes.body.userId).toBe("string");
  });
});
