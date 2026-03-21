import { describe, it, expect } from 'vitest';
import request from "supertest";
import app from "../../../app";

describe("GET /api/client/lender-products", () => {
  it("returns 200 and array", async () => {
    const res = await request(app).get("/api/client/lender-products");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("returns only public product fields", async () => {
    const res = await request(app).get("/api/client/lender-products");
    for (const row of res.body) {
      expect(row.id).toBeDefined();
      expect(row.name).toBeDefined();
      expect(row.type).toBeDefined();
    }
  });
});
