import request from "supertest";
import { createServer } from "../server/createServer";

describe("Health check", () => {
  const app = createServer();
  it("GET /health returns ok", async () => {
    const res = await request(app).get("/health");

    expect(res.body).toEqual({ status: "ok", data: {} });
  });
});
