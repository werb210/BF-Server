// BF_SERVER_BI_UNLINK_DELETED_v404
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "../db.js";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js"; // BF_SERVER_v789_SQL_CONTENT_MOCKS
import { mirrorDocToBi } from "../services/biDocMirror.js";
import { retryMissingBiHandoffs } from "../services/biHandoffRetry.js";

const queryMock = vi.fn();
beforeEach(() => {
  queryMock.mockReset();
  vi.spyOn(pool, "query").mockImplementation(((...a: unknown[]) => queryMock(...a)) as any);
  process.env.JWT_SECRET = "test-secret-long-enough";
});

describe("a BI application deleted in BI", () => {
  it("clears BF's stale link once instead of failing forever", async () => {
    queryMock.mockImplementation(answerBySql([
      [/SELECT bi_public_id FROM applications/, { rows: [{ bi_public_id: "pub-gone" }] }],
    ], { rows: [], rowCount: 1 }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "bi_application_not_found" }), { status: 404 })));
    const r = await mirrorDocToBi({ bfApplicationId: "bf-1", bfDocumentId: "d1", documentType: "bank_statements", fileName: "a.pdf", mimeType: null, fileSize: 1, storageUrl: "x", uploadedByName: null } as any);
    expect(r).toEqual({ ok: false, error: "bi_application_deleted" });
    const clear = callsMatching(queryMock, "SET bi_application_id = NULL")[0];
    expect(clear?.[1]).toEqual(["bf-1", "pub-gone"]);
    vi.unstubAllGlobals();
  });
  it("the automatic handoff retry does not re-create it", async () => {
    queryMock.mockImplementation(answerBySql([]));
    expect(await retryMissingBiHandoffs(20)).toEqual({ tried: 0, linked: 0, failed: 0 });
    const pick = callsMatching(queryMock, /bi_handoff_attempts/)[0];
    expect(String(pick?.[0])).toContain("AND metadata->>'bi_link_cleared_at' IS NULL");
  });
});
