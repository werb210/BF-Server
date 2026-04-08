import request from "supertest";

import { createServer } from "../src/server/createServer";

describe("System stability", () => {
  it("system boots without external services", async () => {
    const app = createServer();
    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.data.server).toBe("ok");
    expect(res.body.data.twilio).toBeUndefined();
    expect(res.body.data.db).toBeUndefined();
  });
});
