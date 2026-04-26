import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../../db.js", async () => ({
  pool: {
    query: queryMock,
    connect: vi.fn(async () => ({ query: queryMock, release: vi.fn() })),
  },
  runQuery: queryMock,
  dbQuery: queryMock,
  query: queryMock,
  safeQuery: queryMock,
}));

describe("PATCH /api/client/applications/:id — uuid validation", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [] });
  });

  async function buildApp() {
    const { default: router } = await import("../client/v1Applications.js");
    const app = express();
    app.use(express.json());
    app.use("/api/client", router);
    app.use((err: any, _req: any, res: any, _next: any) => {
      const status = typeof err?.status === "number" ? err.status : 500;
      res.status(status).json({
        status: "error",
        error: { code: err?.code || "internal", message: err?.message || "error" },
      });
    });
    return app;
  }

  it("returns 410 application_token_stale for legacy 'local-...' ids without touching the DB", async () => {
    const app = await buildApp();
    const res = await request(app)
      .patch("/api/client/applications/local-1768585153909")
      .send({ metadata: { draft: { step: 2 } } });

    expect(res.status).toBe(410);
    expect(res.body?.error?.code).toBe("application_token_stale");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns 410 for any non-uuid id (e.g. 'abc-not-a-uuid')", async () => {
    const app = await buildApp();
    const res = await request(app)
      .patch("/api/client/applications/abc-not-a-uuid")
      .send({ metadata: {} });

    expect(res.status).toBe(410);
    expect(res.body?.error?.code).toBe("application_token_stale");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("accepts a real uuid (proceeds past validation, returns 410 only if not found)", async () => {
    const app = await buildApp();
    queryMock.mockResolvedValueOnce({ rows: [] }); // findApplicationById -> null
    const res = await request(app)
      .patch("/api/client/applications/550e8400-e29b-41d4-a716-446655440000")
      .send({ metadata: { draft: { step: 2 } } });

    expect(res.status).toBe(410);
    expect(res.body?.error?.code).toBe("application_token_stale");
    expect(queryMock).toHaveBeenCalled(); // proved we reached the DB lookup
  });
});
