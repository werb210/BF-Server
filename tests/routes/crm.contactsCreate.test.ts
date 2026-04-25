import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "../../src/db.js";
import crmRouter from "../../src/routes/crm.js";
import { errorHandler } from "../../src/middleware/errors.js";

describe("POST /api/crm/contacts", () => {
  const token = jwt.sign(
    { id: "user-1", capabilities: ["crm:read"] },
    "test-secret"
  );

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.JWT_SECRET = "test-secret";
    vi.spyOn(pool, "query").mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM users WHERE id")) {
        return { rows: [{ id: "user-1", email: "test@example.com", role: "Admin", silo: "BF", silos: ["BF"] }] } as any;
      }
      if (sql.includes("INSERT INTO contacts")) {
        return {
          rows: [{
            id: "contact-1",
            name: params?.[0],
            first_name: params?.[1],
            last_name: params?.[2],
            email: params?.[3],
            phone: params?.[4],
            status: params?.[5],
            company_name: params?.[8],
            job_title: params?.[9],
            lead_status: params?.[10],
            tags: params?.[11],
            owner_id: params?.[12],
            company_id: params?.[13],
            silo: params?.[6],
          }],
        } as any;
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

  it("creates a contact from first_name + last_name", async () => {
    const res = await request(app())
      .post("/api/crm/contacts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.com",
        phone: "555-0000",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("Ada Lovelace");
    expect(res.body.data.first_name).toBe("Ada");
    expect(res.body.data.last_name).toBe("Lovelace");
  });

  it("creates a contact when only name is provided", async () => {
    const res = await request(app())
      .post("/api/crm/contacts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Grace Hopper",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("Grace Hopper");
    expect(res.body.data.first_name).toBeNull();
    expect(res.body.data.last_name).toBeNull();
  });

  it("returns 400 when name and first_name are both missing", async () => {
    const res = await request(app())
      .post("/api/crm/contacts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        email: "missing@example.com",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("first_name or name is required");
  });
});
