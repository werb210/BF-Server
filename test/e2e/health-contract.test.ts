import request from "supertest";

import { createApp } from "../../src/app";

describe("Health contract", () => {
  const app = createApp();

  it("returns structured health response", async () => {
    const res = await request(app).get("/api/health");

    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty("status");
    expect(res.body).toHaveProperty("data");
    expect(res.body.data).toHaveProperty("db");
  });
});
