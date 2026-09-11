import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { ...actual.pool, query: queryMock } };
});

function token() { return jwt.sign({ id:"00000000-0000-0000-0000-000000000001", role:"staff", capabilities:["crm:read","crm:write"] }, "test-jwt-secret-minimum-10-chars"); }

describe("BI workflow smoke", () => {
  it("bulk delete returns 409 when FK protected", async () => {
    vi.resetModules();
    process.env.JWT_SECRET = "test-jwt-secret-minimum-10-chars";
    process.env.OPENAI_API_KEY = "";
    queryMock.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("SELECT c.id FROM contacts c")) {
        return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }] };
      }
      return { rows: [] };
    });
    const { createApp } = await import("../app.js");
    const res = await request(createApp()).post('/api/crm/contacts/bulk-delete').set('Authorization', `Bearer ${token()}`).send({ ids:["11111111-1111-4111-8111-111111111111"] });
    expect(res.status).toBe(409);
  });
});
