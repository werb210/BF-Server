// BF_SERVER_BI_UNLINK_DELETED_v404
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { pool } from "../db.js";
import { mirrorDocToBi } from "../services/biDocMirror.js";

const queryMock = vi.fn();
beforeEach(() => {
  queryMock.mockReset();
  vi.spyOn(pool, "query").mockImplementation(((...a: unknown[]) => queryMock(...a)) as any);
  process.env.JWT_SECRET = "test-secret-long-enough";
});

describe("a BI application deleted in BI", () => {
  it("clears BF's stale link once instead of failing forever", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ bi_public_id: "pub-gone" }] }).mockResolvedValue({ rows: [], rowCount: 1 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "bi_application_not_found" }), { status: 404 })));
    const r = await mirrorDocToBi({ bfApplicationId: "bf-1", bfDocumentId: "d1", documentType: "bank_statements", fileName: "a.pdf", mimeType: null, fileSize: 1, storageUrl: "x", uploadedByName: null } as any);
    expect(r).toEqual({ ok: false, error: "bi_application_deleted" });
    const clear = queryMock.mock.calls.find((c) => String(c[0]).includes("SET bi_application_id = NULL"));
    expect(clear?.[1]).toEqual(["bf-1", "pub-gone"]);
    vi.unstubAllGlobals();
  });
  it("the automatic handoff retry does not re-create it", () => {
    const src = readFileSync(path.join(process.cwd(), "src/services/biHandoffRetry.ts"), "utf8");
    expect(src).toContain("AND metadata->>'bi_link_cleared_at' IS NULL");
  });
});
