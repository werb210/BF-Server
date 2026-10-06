import { describe, expect, it, vi } from "vitest";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js"; // BF_SERVER_SQL_CONTENT_MOCKS_v762
import { createCompany, findOrCreateCompanyByNameAndSilo } from "../companies.js";

describe("companies service", () => {
  it("returns existing company when lower(name)+silo matches", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "c1", name: "Acme", silo: "BF" }] });
    const out = await findOrCreateCompanyByNameAndSilo(
      { query } as any,
      "acme",
      "BF",
      { name: "acme", silo: "BF" }
    );

    expect(out.created).toBe(false);
    expect(out.row.id).toBe("c1");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("creates company when no existing row", async () => {
    const query = vi.fn(answerBySql([
      [/SELECT \* FROM companies/, { rows: [] }],
      [/INSERT INTO companies/, { rows: [{ id: "c2", name: "NewCo", silo: "BF", status: "prospect" }] }],
    ]));

    const out = await findOrCreateCompanyByNameAndSilo(
      { query } as any,
      "NewCo",
      "BF",
      { name: "NewCo", silo: "BF" }
    );

    expect(out.created).toBe(true);
    expect(out.row.id).toBe("c2");
  });

  it("createCompany inserts row", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "c3", name: "Direct", silo: "BF", status: "prospect" }] });
    const out = await createCompany({ query } as any, { name: "Direct", silo: "BF" });
    expect(out.id).toBe("c3");
  });
});
