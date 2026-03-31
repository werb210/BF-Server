import request from "supertest";
import { app } from "../app";

describe("public rate limiting", () => {
  it("limits excessive requests", async () => {
    for (let i = 0; i < 300; i += 1) {
      await request(app).get("/api/public/test");
    }

    const res = await request(app).get("/api/public/test");
    expect(res.status).toBe(429);
  });
});
