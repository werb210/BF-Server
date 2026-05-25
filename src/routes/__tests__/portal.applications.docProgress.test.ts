import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const runQueryMock = vi.fn();

vi.mock("../../db.js", () => ({
  runQuery: runQueryMock,
  pool: { query: vi.fn() },
}));
vi.mock("../../startupState.js", () => ({ fetchStatus: () => ({ reason: "ok" }), isReady: () => true }));
vi.mock("../../middleware/auth.js", () => ({ requireAuth: (_req: any, _res: any, next: any) => next(), requireAuthorization: () => (_req: any, _res: any, next: any) => next() }));

describe("GET /api/portal/applications doc_progress", () => {
  it("returns doc_progress aggregate on pipeline cards", async () => {
    runQueryMock.mockResolvedValueOnce({ rows: [{
      id: "app-1",
      stage: "In Review",
      requested_amount: "15000",
      product_category: "term",
      parent_application_id: null,
      owner_user_id: "owner-1",
      is_draft: false,
      business_name: "Acme LLC",
      contact_name: "Jane",
      contact_email: "jane@example.com",
      owner_name: "Owner Name",
      owner_first_name: "Owner",
      owner_last_name: "Name",
      last_activity_at: "2026-01-01T00:00:00.000Z",
      stage_entered_at: "2026-01-02T00:00:00.000Z",
      doc_progress: { accepted: 1, rejected: 1, pending: 2, total: 4 },
      status_note: "",
    }] });

    const router = (await import("../portal.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/portal", router);

    const res = await request(app).get("/api/portal/applications");
    expect(res.status).toBe(200);
    expect(res.body.applications[0].doc_progress).toEqual({ accepted: 1, rejected: 1, pending: 2, total: 4 });
    expect(res.body.applications[0].stage_entered_at).toBe("2026-01-02T00:00:00.000Z");
  });
});
