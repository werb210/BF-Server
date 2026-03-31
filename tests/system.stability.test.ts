import request from "supertest";

import { createServer } from "../src/server/createServer";

describe("System stability", () => {
  it("system boots without external services", async () => {
    const app = createServer();
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.server).toBe("ok");
    expect(["configured", "missing"]).toContain(res.body.data.twilio);
    expect(["ok", "degraded"]).toContain(res.body.data.db);
  });
});
