import request from "supertest";

import { createServer } from "../../src/server/createServer";

describe("Health contract", () => {
  it("returns plain text ok", async () => {
    const app = createServer();

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.text).toBe("ok");
  });
});
