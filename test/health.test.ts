import request from "supertest";
import type { Express } from "express";
import { getTestApp } from "./setup";

describe.skip("Health", () => {
  let app: Express;

  beforeAll(async () => {
    app = await getTestApp();
  });

  it("GET /healthz", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("GET /readyz", async () => {
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
