import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "../../src/db.js";
import crmRouter from "../../src/routes/crm.js";
import { errorHandler } from "../../src/middleware/errors.js";

describe("CRM companies endpoints", () => {
  const token = jwt.sign(
    { id: "user-1", capabilities: ["crm:read"], silo: "BF" },
    "test-secret"
  );
  const companyId = "22222222-2222-2222-2222-222222222222";

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.JWT_SECRET = "test-secret";

    vi.spyOn(pool, "query").mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM users WHERE id")) {
        return { rows: [{ id: "user-1", email: "test@example.com", role: "Admin", silo: "BF", silos: ["BF"] }] } as any;
      }
      if (sql.includes("INSERT INTO companies")) {
        return {
          rows: [{
            id: companyId,
            name: params?.[0],
            industry: params?.[1],
            domain: params?.[2],
            silo: params?.[7],
          }],
        } as any;
      }
      if (sql.includes("FROM companies co") && sql.includes("WHERE co.silo = $1")) {
        return { rows: [{ id: companyId, name: "Acme", industry: "Finance", owner_name: "Grace Hopper" }] } as any;
      }
      if (sql.includes("FROM companies co") && sql.includes("WHERE co.id = $1 AND co.silo = $2")) {
        return { rows: [{ id: companyId, name: "Acme", industry: "Finance", owner_name: "Grace Hopper" }] } as any;
      }
      if (sql.includes("UPDATE companies SET")) {
        return { rows: [{ id: companyId, industry: params?.[0] }] } as any;
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

  it("creates, lists, gets by id, and patches a company", async () => {
    const createRes = await request(app())
      .post("/api/crm/companies")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Acme", industry: "Finance", domain: "acme.com" });
    expect(createRes.status).toBe(201);
    expect(createRes.body.data.name).toBe("Acme");

    const listRes = await request(app())
      .get("/api/crm/companies")
      .set("Authorization", `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data[0].id).toBe(companyId);

    const getRes = await request(app())
      .get(`/api/crm/companies/${companyId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.name).toBe("Acme");

    const patchRes = await request(app())
      .patch(`/api/crm/companies/${companyId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ industry: "Lending" });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.industry).toBe("Lending");
  });
});
