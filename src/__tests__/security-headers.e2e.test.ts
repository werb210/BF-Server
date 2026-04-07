import request from "supertest";
import { createServer } from "../server/createServer";

describe("security headers", () => {
  const app = createServer();
  it("adds baseline security headers", async () => {
    const res = await request(app).get("/health");

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-xss-protection"]).toBe("1; mode=block");
  });
});
