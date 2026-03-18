import request from "supertest";
import type { Express } from "express";

let app: Express;

describe("internal version endpoint", () => {
  beforeAll(async () => {
    process.env.COMMIT_SHA = "test-sha";
    process.env.NODE_ENV = "test";
    vi.resetModules();
    const { buildAppWithApiRoutes } = await import("../app");
    app = buildAppWithApiRoutes();
  });

  it("returns semantic version and commit hash", async () => {
    const res = await request(app).get("/api/_int/version");

    expect(res.status).toBe(200);
    expect(res.body.commitHash).toBe("test-sha");
    expect(res.body.version).toMatch(/\d+\.\d+\.\d+/);
  });
});
