import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => ({ pool: { query: queryMock, connect: vi.fn() } }));

function token() { return jwt.sign({ id:"00000000-0000-0000-0000-000000000001", role:"staff", capabilities:["crm:read","crm:write"] }, "test-jwt-secret-minimum-10-chars"); }

describe("BI workflow smoke", () => {
  it("bulk delete returns 409 when FK protected", async () => {
    process.env.JWT_SECRET = "test-jwt-secret-minimum-10-chars";
    queryMock.mockResolvedValueOnce({ rows:[{ id:"11111111-1111-4111-8111-111111111111" }] });
    const { createApp } = await import("../app.js");
    const res = await request(createApp()).post('/api/crm/contacts/bulk-delete').set('Authorization', `Bearer ${token()}`).send({ ids:["11111111-1111-4111-8111-111111111111"] });
    expect(res.status).toBe(409);
  });
});
