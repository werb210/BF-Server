import request from "supertest";

import { createServer } from "../../src/server/createServer";

describe("Health contract", () => {
  it("returns structured health status", async () => {
    const app = createServer();

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      api: "ok",
    });
    expect(["ok", "down"]).toContain(res.body.db);
    expect(typeof res.body.timestamp).toBe("number");
  });
});
