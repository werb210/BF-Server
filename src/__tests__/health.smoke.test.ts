import request from "supertest";
import { createApp } from "../app";

describe("Health check", () => {
  const app = createApp();
  it("GET /health returns ok", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
