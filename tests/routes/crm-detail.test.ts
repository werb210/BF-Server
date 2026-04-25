import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "../../src/db.js";
import crmRouter from "../../src/routes/crm.js";
import { errorHandler } from "../../src/middleware/errors.js";

describe("CRM contact detail endpoints", () => {
  const token = jwt.sign(
    { id: "user-1", capabilities: ["crm:read"], silo: "BF" },
    "test-secret"
  );
  const contactId = "11111111-1111-1111-1111-111111111111";

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
            id: contactId,
            name: params?.[0],
            first_name: params?.[1],
            last_name: params?.[2],
            email: params?.[3],
            phone: params?.[4],
            job_title: params?.[9],
            lead_status: params?.[10],
            silo: params?.[6],
          }],
        } as any;
      }
      if (sql.includes("FROM contacts c") && sql.includes("WHERE c.id = $1 AND c.silo = $2")) {
        return {
          rows: [{
            id: contactId,
            first_name: "Ada",
            last_name: "Lovelace",
            name: "Ada Lovelace",
            email: "ada@example.com",
            job_title: "Mathematician",
            company_name: "Analytical Engines",
            owner_name: "Grace Hopper",
            silo: "BF",
          }],
        } as any;
      }
      if (sql.includes("UPDATE contacts SET")) {
        return {
          rows: [{
            id: contactId,
            job_title: params?.[0],
            notes: params?.[1],
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

  it("creates, reads by id, patches, and reads again", async () => {
    const createRes = await request(app())
      .post("/api/crm/contacts")
      .set("Authorization", `Bearer ${token}`)
      .send({ first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data.id).toBe(contactId);

    const getRes = await request(app())
      .get(`/api/crm/contacts/${contactId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(getRes.status).toBe(200);
    expect(getRes.body.data.company_name).toBe("Analytical Engines");

    const patchRes = await request(app())
      .patch(`/api/crm/contacts/${contactId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ job_title: "Programmer", notes: "Updated" });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.job_title).toBe("Programmer");

    const getAgainRes = await request(app())
      .get(`/api/crm/contacts/${contactId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(getAgainRes.status).toBe(200);
    expect(getAgainRes.body.data.id).toBe(contactId);
  });
});
