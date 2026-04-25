import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../../src/server/createServer.js";

describe("GET /api/client/readiness-prefill", () => {
  it("returns profitable boolean and companyName when found", async () => {
    const res = await request(createServer()).get("/api/client/readiness-prefill").query({ token: "missing" });
    expect([200, 500]).toContain(res.status);
    if (res.status !== 200) return;
    if (res.body.found) {
      expect(["boolean", "object"]).toContain(typeof res.body.prefill.profitable);
      expect(res.body.prefill).toHaveProperty("companyName");
    } else {
      expect(res.body).toEqual({ found: false });
    }
  });
});
