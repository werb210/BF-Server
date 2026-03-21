import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import otpRouter from "../routes/auth/otp";

describe("internal routes + CORS", () => {
  const app = buildAppWithApiRoutes();
  app.use("/auth/otp", otpRouter);

  it("returns routes inventory without auth", async () => {
    const res = await request(app).get("/api/_int/routes");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("routes");
  });

  it("allows preflight with x-request-id", async () => {
    const res = await request(app)
      .options("/auth/otp/start")
      .set("Origin", "https://staff.boreal.financial")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,idempotency-key");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-headers"]?.toLowerCase()).toEqual(
      expect.stringContaining("idempotency-key")
    );
  });
});
