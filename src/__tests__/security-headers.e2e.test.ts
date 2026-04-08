import request from "supertest";
import { createApp } from "../app";

describe("security headers", () => {
  const app = createApp();
  it("adds baseline security headers", async () => {
    const res = await request(app).get("/health");

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});
