import { describe, it, expect, vi, beforeEach } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: queryMock } };
});

describe("BF_LENDER_MIRROR_FIX_v52 lenderCrmMirror ON CONFLICT predicate", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [{ id: "co-1" }] });
  });

  it("upsert SQL includes WHERE lender_id IS NOT NULL on the conflict target", async () => {
    const { mirrorLenderToCrm } = await import("../lenderCrmMirror.js");
    await mirrorLenderToCrm({
      id: "lender-1",
      name: "Acme Capital",
      phone: null,
      silo: "BF",
      country: "CA",
      contact_name: null,
      contact_email: null,
      contact_phone: null,
    });

    expect(queryMock).toHaveBeenCalled();
    const upsertSql = String(queryMock.mock.calls[0][0]);
    expect(upsertSql).toMatch(
      /ON CONFLICT\s*\(\s*lender_id\s*\)\s+WHERE\s+lender_id\s+IS\s+NOT\s+NULL\s+DO\s+UPDATE/i
    );
  });
});
