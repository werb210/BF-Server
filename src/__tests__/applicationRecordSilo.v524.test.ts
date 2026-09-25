// BF_SERVER_BLOCK_v524
import { describe, expect, it, vi } from "vitest";
import { findApplicationById } from "../modules/applications/applications.repo.js";

describe("findApplicationById", () => {
  it("returns contact_id and silo", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "a1", contact_id: "c1", silo: "BF" }] }));
    const row = await findApplicationById("a1", { query } as any);
    expect(String((query.mock.calls[0] as unknown[])[0])).toMatch(/contact_id, silo/);
    expect(row?.contact_id).toBe("c1");
    expect(row?.silo).toBe("BF");
  });
});
