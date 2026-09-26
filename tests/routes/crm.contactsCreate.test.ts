// BF_SERVER_BLOCK_v572 - rewritten for the current POST /api/crm/contacts: it needs
// crm:write (v152), creates through services/contacts.createContact, splits a full
// name into first/last (last defaults to "Unknown"), and reports a missing name as
// { error: { field: "first_name" } }.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createContact } = vi.hoisted(() => ({
  createContact: vi.fn(async (_pool: unknown, input: Record<string, unknown>) => ({ id: "contact-1", ...input })),
}));
vi.mock("../../src/services/contacts.js", () => ({ createContact }));
vi.mock("../../src/modules/o365/contactSync.js", () => ({ pushContactToOutlook: vi.fn(async () => undefined) }));

import { pool } from "../../src/db.js";
import crmRouter from "../../src/routes/crm.js";
import { errorHandler } from "../../src/middleware/errors.js";

describe("POST /api/crm/contacts", () => {
  const token = jwt.sign({ id: "user-1", capabilities: ["crm:read", "crm:write"] }, "test-secret");

  beforeEach(() => {
    createContact.mockClear();
    process.env.JWT_SECRET = "test-secret";
    vi.spyOn(pool, "query").mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE id")) {
        return { rows: [{ id: "user-1", email: "test@example.com", role: "Admin", silo: "BF", silos: ["BF"] }] } as any;
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
    const res = await request(app()).post("/api/crm/contacts").set("Authorization", `Bearer ${token}`)
      .send({ first_name: "Ada", last_name: "Lovelace", email: "ada@example.com", phone: "555-0000" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: "contact-1", first_name: "Ada", last_name: "Lovelace", email: "ada@example.com", owner_id: "user-1" });
  });

  it("splits a full name when only name is provided", async () => {
    const res = await request(app()).post("/api/crm/contacts").set("Authorization", `Bearer ${token}`).send({ name: "Grace Brewster Hopper" });
    expect(res.status).toBe(201);
    expect(createContact.mock.calls[0][1]).toMatchObject({ first_name: "Grace", last_name: "Brewster Hopper" });
  });

  it("returns 400 when no name is given", async () => {
    const res = await request(app()).post("/api/crm/contacts").set("Authorization", `Bearer ${token}`).send({ email: "missing@example.com" });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe("first_name");
    expect(createContact).not.toHaveBeenCalled();
  });

  it("refuses staff without crm:write", async () => {
    const readOnly = jwt.sign({ id: "user-1", capabilities: ["crm:read"] }, "test-secret");
    const res = await request(app()).post("/api/crm/contacts").set("Authorization", `Bearer ${readOnly}`).send({ first_name: "A", last_name: "B" });
    expect(res.status).toBe(403);
  });
});
