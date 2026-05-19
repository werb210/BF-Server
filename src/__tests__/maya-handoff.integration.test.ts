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
      capabilities: ["communications:read"],
    },
    secret,
    { expiresIn: "1h" },
  );
}

describe("communications maya handoff", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    queryMock.mockReset();
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "test-jwt-secret-minimum-10-chars";
    process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000000";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_CALLER_ID = "+18254511768";
    process.env.MAYA_FALLBACK_SMS_NUMBERS = "+15555550123,+15555550124";

    queryMock.mockResolvedValue({ rows: [] });
  });

  it("POST /api/communications/maya-handoff with available recipients writes escalation + comm message", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ phone: "+15555550111" }] });

    const fetchSpy = vi.spyOn(globalThis, "fetch" as any).mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => "ok",
    } as any);

    const { createApp } = await import("../app.js");
    const app = createApp();
    const token = makeAuthToken();

    const res = await request(app)
      .post("/api/communications/maya-handoff")
      .set("Authorization", `Bearer ${token}`)
      .send({ recipients: "available", summary: "Need human", surface: "web", sessionId: "sess-1" });

    expect(res.status).toBe(200);
    expect(res.body?.status).toBe("ok");
    expect(fetchSpy).toHaveBeenCalled();

    const sqlCalls = queryMock.mock.calls.map((c) => String(c[0]));
    expect(sqlCalls.some((sql) => sql.includes("INSERT INTO maya_escalations"))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes("INSERT INTO communications_messages") && sql.includes("'maya_handoff'"))).toBe(true);
  });

  it("POST /api/communications/maya-handoff with fallback recipients returns fallback fanout", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch" as any).mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => "ok",
    } as any);

    const { createApp } = await import("../app.js");
    const app = createApp();
    const token = makeAuthToken();

    const res = await request(app)
      .post("/api/communications/maya-handoff")
      .set("Authorization", `Bearer ${token}`)
      .send({ recipients: "fallback", summary: "Need human" });

    expect(res.status).toBe(200);
    expect(res.body?.fanout?.recipients).toBe("fallback");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("POST /api/communications/maya-handoff without recipients returns 400", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp();
    const token = makeAuthToken();

    const res = await request(app)
      .post("/api/communications/maya-handoff")
      .set("Authorization", `Bearer ${token}`)
      .send({ summary: "Need human" });

    expect(res.status).toBe(400);
    expect(res.body?.error).toBe("recipients_required");
  });

  it("POST /api/communications/maya-handoff without auth returns 401", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp();

    const res = await request(app)
      .post("/api/communications/maya-handoff")
      .send({ recipients: "fallback" });

    expect(res.status).toBe(401);
  });
});
