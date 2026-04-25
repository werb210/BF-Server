import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../../src/server/createServer.js";

describe("GET /api/client/lender-products", () => {
  it("returns envelope shape", async () => {
    const res = await request(createServer()).get("/api/client/lender-products");
    expect([200, 500]).toContain(res.status);
    if (res.status !== 200) return;
    expect(res.body).toHaveProperty("status", "ok");
    expect(Array.isArray(res.body.data)).toBe(true);
    if (res.body.data[0]) {
      expect(res.body.data[0]).toHaveProperty("amount_min");
      expect(res.body.data[0]).toHaveProperty("amount_max");
    }
  });
});
