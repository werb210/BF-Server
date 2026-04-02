import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app";
import { signJwt } from "../auth/jwt";
import { CAPABILITIES } from "../auth/capabilities";
import { pool, runQuery } from "../db";

describe("server:contract:e2e", () => {
  const authHeader = () =>
    `Bearer ${signJwt({
      userId: "test-user",
      role: "Admin",
      capabilities: [CAPABILITIES.COMMUNICATIONS_CALL],
    })}`;

  beforeEach(() => {
    vi.spyOn(pool, "query").mockResolvedValue({ rows: [{ count: "0" }] } as never);
  });

  function expectContractEnvelope(body: any) {
    expect(body).toHaveProperty("status");
    expect(typeof body.rid).toBe("string");
    if (body.status === "ok") {
      expect(body).toHaveProperty("data");
      return;
    }

    expect(body).toHaveProperty("error");
    expect(typeof body.error).toBe("string");
  }

  it("supports canonical dialer token route", async () => {
    const res = await request(app)
      .get("/api/v1/voice/token")
      .set("Authorization", authHeader());

    expect(res.status).toBe(200);
    expectContractEnvelope(res.body);
  });

  it("supports canonical call start route", async () => {
    const res = await request(app)
      .post("/api/v1/call/start")
      .set("Authorization", authHeader())
      .send({ to: "+61400000000" });

    expect(res.status).toBe(200);
    expectContractEnvelope(res.body);
  });

  it("supports canonical voice status route", async () => {
    const res = await request(app)
      .post("/api/v1/voice/status")
      .set("Authorization", authHeader())
      .send({ callId: "call-123", status: "completed" });

    expect(res.status).toBe(200);
    expectContractEnvelope(res.body);
  });

  it("returns structured errors for legacy route aliases", async () => {
    const res = await request(app).get("/api/public/test");

    expect(res.status).toBe(410);
    expectContractEnvelope(res.body);
    expect(res.body.error).toBe("LEGACY_ROUTE_DISABLED");
  });
});
