import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import v1ApplicationsRouter from "../../src/routes/client/v1Applications.js";
import { errorHandler } from "../../src/middleware/errors.js";
import * as applicationsRepo from "../../src/modules/applications/applications.repo.js";

describe("PATCH /api/client/applications/:id stale token handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(applicationsRepo, "findApplicationById").mockResolvedValue(null as any);
  });

  it("returns 410 application_token_stale when the application id does not exist", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/client", v1ApplicationsRouter);
    app.use(errorHandler);

    const res = await request(app)
      .patch("/api/client/applications/non-existent-id")
      .send({ business_name: "Updated" });

    expect(res.status).toBe(410);
    expect(res.body.code).toBe("application_token_stale");
  });
});
