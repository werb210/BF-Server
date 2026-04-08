import request from "supertest";
import { createApp } from "../app";

describe("Health check", () => {
  const app = createApp();
  it("GET /health returns ok", async () => {
    const res = await request(app).get("/health");

    expect(res.body).toMatchObject({ db: expect.any(Boolean), openai: expect.any(Boolean), twilio: expect.any(Boolean) });
  });
});
