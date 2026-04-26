import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return {
    ...actual,
    pool: {
      query: queryMock,
      connect: vi.fn(async () => ({ query: queryMock, release: vi.fn() })),
    },
  };
});

describe("POST /api/maya/escalations", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  async function buildApp() {
    const { default: router } = await import("../maya.js");
    const app = express();
    app.use(express.json());
    app.use("/api/maya", router);
    app.use((err: any, _req: any, res: any, _next: any) => {
      const status = typeof err?.statusCode === "number" ? err.statusCode : 500;
      res.status(status).json({
        status: "error",
        error: { code: err?.code || "internal", message: err?.message || "error" },
      });
    });
    return app;
  }

  it("persists a new escalation and returns 201 with id", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }); // dedupe lookup → none
    queryMock.mockResolvedValueOnce({ rows: [] }); // insert

    const app = await buildApp();
    const res = await request(app)
      .post("/api/maya/escalations")
      .send({
        reason: "user_requested_human",
        sessionId: "sess-abc",
        surface: "client_app",
      });

    expect(res.status).toBe(201);
    expect(res.body?.data?.deduped).toBe(false);
    expect(res.body?.data?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("dedupes a repeat (sessionId + reason) within 60s and returns the existing id", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: "11111111-1111-4111-8111-111111111111" }],
    });

    const app = await buildApp();
    const res = await request(app)
      .post("/api/maya/escalations")
      .send({ reason: "user_requested_human", sessionId: "sess-abc" });

    expect(res.status).toBe(200);
    expect(res.body?.data?.deduped).toBe(true);
    expect(res.body?.data?.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(queryMock).toHaveBeenCalledTimes(1); // dedupe SELECT only, no INSERT
  });

  it("ignores a non-uuid applicationId rather than rejecting", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    const res = await request(app)
      .post("/api/maya/escalations")
      .send({
        reason: "low_confidence",
        sessionId: "sess-xyz",
        applicationId: "local-1768585153909", // not a uuid → recorded as null
      });

    expect(res.status).toBe(201);
    const insertCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO maya_escalations")
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1][2]).toBeNull(); // application_id arg → null
  });
});
