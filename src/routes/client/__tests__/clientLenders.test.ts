import { describe, it, expect } from 'vitest';
import request from "supertest";
import app from "../../../app";

describe("GET /api/client/lenders", () => {
  it("returns 200 and array", async () => {
    const res = await request(app).get("/api/client/lenders");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("never returns inactive lenders", async () => {
    const res = await request(app).get("/api/client/lenders");
    for (const lender of res.body.data) {
      expect(lender.status).toBeUndefined();
    }
  });
});
