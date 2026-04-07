import request from "supertest";

import { createApp } from "../../src/app";

describe("CORS contract", () => {
  const app = createApp();

  it("returns 410 when origin missing", async () => {
    const res = await request(app)
      .options("/anything")
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(410);
    expect(res.body).toEqual({
      status: "error",
      error: "LEGACY_ROUTE_DEPRECATED",
    });
  });
});
