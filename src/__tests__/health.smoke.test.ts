import request from "supertest";
import app from "../index";

describe("Health check", () => {
  it("GET /health returns ok", async () => {
    const res = await request(app).get("/health");

    expect(res.body.status).toBe("ok");
  });
});
