import { beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import request from "supertest";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return {
    ...actual,
    pool: {
      query: queryMock,
    },
  };
});

function makeAuthToken() {
  const secret = process.env.JWT_SECRET as string;
  return jwt.sign(
    {
      sub: "00000000-0000-0000-0000-000000000001",
      id: "00000000-0000-0000-0000-000000000001",
      role: "staff",
      capabilities: ["crm:read"],
    },
    secret,
    { expiresIn: "1h" },
  );
}

describe("CRM + CORS + telephony regressions", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();

    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "test-jwt-secret-minimum-10-chars";

    process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000000";
    process.env.TWILIO_API_KEY = "SK00000000000000000000000000000000";
    process.env.TWILIO_API_SECRET = "test-api-secret";
    process.env.TWILIO_VOICE_APP_SID = "AP00000000000000000000000000000000";
    process.env.OPENAI_API_KEY = "";
  });

  it("POST /api/crm/contacts returns 201 with UUID id", async () => {
    const createdId = "11111111-1111-4111-8111-111111111111";
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: createdId,
        name: "Test Contact",
        email: "test@example.com",
        phone: "+15555550123",
        status: "active",
        created_at: new Date().toISOString(),
        user_id: "00000000-0000-0000-0000-000000000001",
      }],
    });

    const { createApp } = await import("../app.js");
    const app = createApp();
    const token = makeAuthToken();

    const res = await request(app)
      .post("/api/crm/contacts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Test Contact", email: "test@example.com", phone: "+15555550123" });

    expect(res.status).toBe(201);
    expect(res.body?.data?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("OPTIONS /api/crm/contacts allows https://staff.boreal.financial", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp();

    const res = await request(app)
      .options("/api/crm/contacts")
      .set("Origin", "https://staff.boreal.financial")
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://staff.boreal.financial");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("GET /api/telephony/token returns a valid token when env vars are set", async () => {
    queryMock.mockResolvedValue({ rows: [] });

    const { createApp } = await import("../app.js");
    const app = createApp();
    const token = makeAuthToken();

    const res = await request(app)
      .get("/api/telephony/token")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    expect(res.body?.data?.token).toBeTypeOf("string");
    expect(res.body?.data?.token.split(".")).toHaveLength(3);
  });

  it("GET /api/telephony/token returns 503 with missing env details", async () => {
    delete process.env.TWILIO_VOICE_APP_SID;

    const { createApp } = await import("../app.js");
    const app = createApp();
    const token = makeAuthToken();

    const res = await request(app)
      .get("/api/telephony/token")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      success: false,
      error: "telephony_not_configured",
      missing: ["TWILIO_VOICE_APP_SID"],
    });
    expect(res.body?.message).toContain("Missing required Twilio env vars");
  });
});
