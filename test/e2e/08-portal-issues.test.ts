import request from "supertest";
import type { Express } from "express";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../../src/server/createServer";
import { generateTestToken } from "../utils/token";
import { deps } from "../../src/system/deps.js";

describe("Portal issues routes", () => {
  let app: Express;
  let authHeader: string;
  const queryMock = vi.fn();

  beforeAll(() => {
    app = createServer();
    authHeader = `Bearer ${generateTestToken({ role: "staff" })}`;
  });

  beforeEach(() => {
    queryMock.mockReset();
    deps.db.ready = true;
    deps.db.client = { query: queryMock } as any;
  });

  it("GET /api/portal/issues returns empty array when no issues exist", async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/api/portal/issues")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ issues: [] });
  });

  it("PATCH /api/portal/issues/:id/status updates issue status", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: "issue-1", status: "resolved" }],
      rowCount: 1,
    });

    const res = await request(app)
      .patch("/api/portal/issues/issue-1/status")
      .set("Authorization", authHeader)
      .send({ status: "resolved" });

    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe("resolved");
    expect(queryMock).toHaveBeenCalledWith(
      "UPDATE issues SET status = $1, updated_at = now() WHERE id = $2 RETURNING *",
      ["resolved", "issue-1"],
    );
  });
});
