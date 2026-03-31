import request from "supertest";

import { createServer } from "../../src/server/createServer";

describe("Health contract", () => {
  it("returns structured health status", async () => {
    const app = createServer();

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.server).toBe("ok");
    expect(["configured", "missing"]).toContain(res.body.data.twilio);
    expect(["ok", "degraded"]).toContain(res.body.data.db);
    expect(res.body.data).toHaveProperty("version");
    expect(res.body.data.environment).toBe(process.env.NODE_ENV ?? "test");
  });
});
