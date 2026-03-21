import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";

const app = buildAppWithApiRoutes();

describe("smoke", () => {
  it("responds to health checks", async () => {
    const res = await request(app).get("/api/_int/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ ok: true }));
  });
});
