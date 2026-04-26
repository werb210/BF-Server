import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: queryMock } };
});

describe("POST /api/companies", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret";
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE id = $1")) return { rows: [{ id: "00000000-0000-0000-0000-000000000001", role: "admin", silo: "BF", silos: ["BF"] }] };
      return { rows: [] };
    });
  });

  function token() {
    return jwt.sign({ id: "00000000-0000-0000-0000-000000000001", role: "admin", capabilities: ["crm:read"] }, "test-secret");
  }

  async function app() {
    const router = (await import("../companies.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/companies", router);
    return app;
  }

  it("returns 201 with UUID and new fields", async () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "smoke",
      legal_name: "smoke legal",
      dba_name: null,
      business_structure: null,
      address_street: null,
      address_city: null,
      address_state: null,
      address_zip: null,
      address_country: null,
      start_date: null,
      employee_count: 5,
      estimated_annual_revenue: 123.45,
    };
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE id = $1")) return { rows: [{ id: "00000000-0000-0000-0000-000000000001", role: "admin", silo: "BF", silos: ["BF"] }] };
      if (sql.includes("INSERT INTO companies")) return { rows: [row] };
      return { rows: [] };
    });

    const res = await request(await app())
      .post("/api/companies")
      .set("Authorization", `Bearer ${token()}`)
      .send({ name: "smoke", legal_name: "smoke legal", employee_count: 5, estimated_annual_revenue: 123.45 });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(res.body.data.legal_name).toBe("smoke legal");
    expect(res.body.data.employee_count).toBe(5);
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(await app())
      .post("/api/companies")
      .set("Authorization", `Bearer ${token()}`)
      .send({ legal_name: "missing" });

    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe("name");
  });
});
