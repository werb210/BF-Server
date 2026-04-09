import request from "supertest";

import { createApp } from "../../src/app";

describe("CORS contract", () => {
  const app = createApp();

  it("handles preflight even when origin is missing", async () => {
    const res = await request(app)
      .options("/anything")
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(204);
  });
});
