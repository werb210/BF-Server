import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "../../src/db.js";
import clientIssuesRouter from "../../src/routes/clientIssues.js";
import { errorHandler } from "../../src/middleware/errors.js";

describe("POST /api/client/issues", () => {
  beforeEach(() => {
    vi.spyOn(pool, "query").mockResolvedValue({ rows: [{ id: "issue-1" }] } as any);
  });

  function buildApp() {
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/client/issues", clientIssuesRouter);
    app.use(errorHandler);
    return app;
  }

  it("returns 201 and received=true for valid payload", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/client/issues")
      .set("user-agent", "vitest")
      .set("referer", "https://example.test/wizard")
      .send({ message: "x" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("ok");
    expect(res.body.data.received).toBe(true);
  });

  it("returns 400 for empty payload", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/client/issues").send({});

    expect(res.status).toBe(400);
  });

  it("returns 400 when message exceeds 4000 chars", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/client/issues")
      .send({ message: "a".repeat(4001) });

    expect(res.status).toBe(400);
  });

  it("inserts expected columns and values", async () => {
    const app = buildApp();

    await request(app)
      .post("/api/client/issues")
      .set("user-agent", "vitest-agent")
      .set("referer", "https://example.test/path")
      .send({
        message: "Issue details",
        contactPhone: "+15551234567",
        screenshotBase64: "abc123",
      });

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = (pool.query as any).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO client_issues");
    expect(sql).toContain("(application_id, contact_phone, message, screenshot_b64, user_agent, url)");
    expect(params).toEqual([
      null,
      "+15551234567",
      "Issue details",
      "abc123",
      "vitest-agent",
      "https://example.test/path",
    ]);
  });
});
