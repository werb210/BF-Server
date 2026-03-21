import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../../app";

const app = buildAppWithApiRoutes();

describe("POST /api/lender-submissions/:applicationId/submit", () => {
  it("blocks unauthorized access", async () => {
    const res = await request(app).post("/api/lender-submissions/app-123/submit");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
