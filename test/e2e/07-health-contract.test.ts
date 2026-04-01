import request from "supertest";

import { createServer } from "../../src/server/createServer";

describe("Health contract", () => {
  it("returns structured health status", async () => {
    const app = createServer();

    const res = await request(app).get("/api/health");

    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty("status");

    if (res.status === 200) {
      expect(res.body).toHaveProperty("data");
      expect(res.body.data).toHaveProperty("db", "ok");
    } else {
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toHaveProperty("message", "DB_UNAVAILABLE");
    }
  });
});
