import request from "supertest";
import { createApp } from "../app";

describe("public rate limiting", () => {
  const app = createApp();
  it("returns structured 404 for unknown public route", async () => {
    for (let i = 0; i < 100; i += 1) {
      await request(app).get("/api/public/test");
    }

    const res = await request(app).get("/api/public/test");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Route not found", path: "/api/public/test" });
  });
});
