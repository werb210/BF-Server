import request from "supertest";
import { createApp } from "../app";

describe("public rate limiting", () => {
  const app = createApp();
  it("limits excessive requests", async () => {
    for (let i = 0; i < 100; i += 1) {
      await request(app).get("/api/v1/public/test");
    }

    const res = await request(app).get("/api/v1/public/test");
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("1");
    expect(res.body).toHaveProperty("status", "error");
    expect(typeof res.body.error).toBe("string");
    expect(typeof res.body.rid).toBe("string");
  });
});
