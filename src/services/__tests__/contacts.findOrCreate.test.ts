import { describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js"; // BF_SERVER_v789_SQL_CONTENT_MOCKS
import { decryptSsnFromRow } from "../../security/ssnCrypto.js";
import { createContact, findOrCreateContactByEmailAndCompany } from "../contacts.js";

describe("contacts service", () => {
  it("returns existing contact when lower(email)+company+silo matches", async () => {
    const query = vi.fn(answerBySql([[/FROM contacts/, { rows: [{ id: "k1", email: "a@b.com", company_id: "co1", silo: "BF" }] }]]));
    const out = await findOrCreateContactByEmailAndCompany(
      { query } as any,
      "A@B.COM",
      "co1",
      "BF",
      { first_name: "A", last_name: "B", email: "a@b.com", silo: "BF", company_id: "co1" }
    );
    expect(out.created).toBe(false);
    expect(out.row.id).toBe("k1");
    expect(callsMatching(query, /INSERT INTO contacts/)).toHaveLength(0);
  });

  it("encrypts SSN before insert and can decrypt roundtrip", async () => {
    process.env.JWT_SECRET = "test-secret-12345";
    process.env.BF_SSN_ENCRYPTION_FALLBACK = "1";
    let encrypted: Buffer | null = null;
    const query = vi.fn().mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes("INSERT INTO contacts")) {
        encrypted = params?.[7] ?? null;
        return { rows: [{ id: "k2", first_name: "S", last_name: "S", role: "applicant", is_primary_applicant: true, silo: "BF" }] };
      }
      return { rows: [] };
    });

    await createContact(
      { query } as any,
      { first_name: "S", last_name: "S", email: "s@example.com", ssn: "123-45-6789", role: "applicant", silo: "BF" }
    );

    expect(Buffer.isBuffer(encrypted)).toBe(true);
    const plain = await decryptSsnFromRow({ query: vi.fn() } as any, encrypted);
    expect(plain).toBe("123-45-6789");
  });
});
