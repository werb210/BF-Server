import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "../../src/db.js";
import crmRouter from "../../src/routes/crm.js";
import { errorHandler } from "../../src/middleware/errors.js";

describe("Admin-only DELETE routes", () => {
  const staffToken = jwt.sign(
    { id: "staff-1", role: "Staff", capabilities: ["crm:read"] },
    "test-secret"
  );
  const adminToken = jwt.sign(
    { id: "admin-1", role: "Admin", capabilities: ["crm:read"] },
    "test-secret"
  );

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.JWT_SECRET = "test-secret";
    vi.spyOn(pool, "query").mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM users WHERE id")) {
        const id = params?.[0];
        if (id === "staff-1") {
          return {
            rows: [{ id: "staff-1", email: "staff@example.com", role: "Staff", silo: "BF", silos: ["BF"] }],
          } as any;
        }
        return {
          rows: [{ id: "admin-1", email: "admin@example.com", role: "Admin", silo: "BF", silos: ["BF"] }],
        } as any;
      }
      if (sql.includes("DELETE FROM contacts")) {
        return { rowCount: 1, rows: [] } as any;
      }
      return { rows: [] } as any;
    });
  });

  function app() {
    const a = express();
    a.use(express.json());
    a.use("/api/crm", crmRouter);
    a.use(errorHandler);
    return a;
  }

  it("returns 403 for staff role", async () => {
    const res = await request(app())
      .delete("/api/crm/contacts/11111111-1111-1111-1111-111111111111")
      .set("Authorization", `Bearer ${staffToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("admin_only");
  });

  it("allows admin role", async () => {
    const res = await request(app())
      .delete("/api/crm/contacts/11111111-1111-1111-1111-111111111111")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
