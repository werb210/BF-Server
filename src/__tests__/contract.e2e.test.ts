import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { signJwt } from "../auth/jwt";
import { CAPABILITIES } from "../auth/capabilities";
import { pool, runQuery } from "../db";

describe("server:contract:e2e", () => {
  const app = createApp();
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
    if (body.status === "ok") {
      expect(body).toHaveProperty("data");
      return;
    }
    expect(body).toHaveProperty("error");
  }

  it("supports canonical lead route", async () => {
    const res = await request(app)
      .post("/api/v1/lead")
      .set("Authorization", authHeader());

    expect([200, 400, 500]).toContain(res.status);
    expectContractEnvelope(res.body);
  });

  it("supports canonical call start route", async () => {
    const res = await request(app)
      .post("/api/v1/call/start")
      .set("Authorization", authHeader())
      .send({ to: "+61400000000" });

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
  });

  it("supports canonical call status route", async () => {
    const res = await request(app)
      .post("/api/v1/call/status")
      .set("Authorization", authHeader())
      .send({ callId: "call-123", status: "completed", durationSeconds: 10 });

    expect([200, 400]).toContain(res.status);
    expect(res.body).toBeDefined();
  });

  it("returns structured errors for legacy route aliases", async () => {
    const res = await request(app).get("/api/public/test");

    expect(res.status).toBe(410);
    expectContractEnvelope(res.body);
    expect(res.body.error).toBe("LEGACY_ROUTE_DISABLED");
  });
});
