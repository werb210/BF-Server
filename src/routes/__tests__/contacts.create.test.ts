import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSsnFromRow } from "../../security/ssnCrypto.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: queryMock } };
});

describe("POST /api/crm/contacts", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret-12345";
    process.env.BF_SSN_ENCRYPTION_FALLBACK = "1";
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE id = $1")) return { rows: [{ id: "00000000-0000-0000-0000-000000000001", role: "admin", silo: "BF", silos: ["BF"] }] };
      return { rows: [] };
    });
  });

  function token() {
    return jwt.sign({ id: "00000000-0000-0000-0000-000000000001", role: "admin", capabilities: ["crm:read"] }, "test-secret-12345");
  }

  async function app() {
    const router = (await import("../crm.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/crm", router);
    return app;
  }

  it("encrypts SSN and does not return ssn fields", async () => {
    let insertedEncrypted: Buffer | null = null;
    queryMock.mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes("FROM users WHERE id = $1")) return { rows: [{ id: "00000000-0000-0000-0000-000000000001", role: "admin", silo: "BF", silos: ["BF"] }] };
      if (sql.includes("INSERT INTO contacts")) {
        insertedEncrypted = params?.[7] ?? null;
        return {
          rows: [{
            id: "11111111-1111-4111-8111-111111111111",
            name: "Jane Doe",
            first_name: "Jane",
            last_name: "Doe",
            email: "jane@example.com",
            role: "applicant",
          }],
        };
      }
      return { rows: [] };
    });

    const res = await request(await app())
      .post("/api/crm/contacts")
      .set("Authorization", `Bearer ${token()}`)
      .send({ first_name: "Jane", last_name: "Doe", email: "jane@example.com", ssn: "123-45-6789", role: "applicant" });

    expect(res.status).toBe(201);
    expect(res.body.data.ssn).toBeUndefined();
    expect(res.body.data.ssn_encrypted).toBeUndefined();
    expect(Buffer.isBuffer(insertedEncrypted)).toBe(true);
    const plain = await decryptSsnFromRow({ query: vi.fn() } as any, insertedEncrypted);
    expect(plain).toBe("123-45-6789");
  });
});
