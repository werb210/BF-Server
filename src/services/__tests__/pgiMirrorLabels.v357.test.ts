// BF_SERVER_PGI_MIRROR_LABELS_v357
import { describe, it, expect, vi, beforeEach } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { bootIndex } from "../../__tests__/helpers/bootIndex.js";

const query = vi.fn();
const logInfo = vi.fn();
vi.mock("../../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock("../../observability/logger.js", async (orig) => ({ ...(await orig() as any), logInfo: (...a: unknown[]) => logInfo(...a) }));
import { backfillPgiMirrors, mirrorDocToBiAsync, pgiDocTypeFor, shouldMirrorToPgi } from "../biDocMirror.js";

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(answerBySql([]));
  logInfo.mockReset();
});

describe("PGI mirror recognises the labels documents are filed under", () => {
  it("maps the Request Items labels", () => {
    expect(pgiDocTypeFor("A/R")).toBe("ar_aging");
    expect(pgiDocTypeFor("A/P")).toBe("ap_aging");
    expect(pgiDocTypeFor("PnL – Interim financials")).toBe("profit_loss");
    expect(pgiDocTypeFor("P&L – Interim financials")).toBe("profit_loss");
    expect(pgiDocTypeFor("Balance Sheet – Interim financials")).toBe("balance_sheet");
  });
  it("still maps the original codes", () => {
    expect(pgiDocTypeFor("ap")).toBe("ap_aging");
    expect(pgiDocTypeFor("pnl_interim")).toBe("profit_loss");
  });
  it("does not mirror documents PGI does not take", () => {
    for (const v of ["6 months business banking statements", "3 years accountant prepared financials", "VOID cheque or PAD", "Other"]) {
      expect(shouldMirrorToPgi(v)).toBe(false);
    }
  });

  it("logs skipped mirrors with the reason", async () => {
    // No BI link for this application: the mirror is skipped, and says so.
    mirrorDocToBiAsync({ bfApplicationId: "bf-1", bfDocumentId: "d-1", documentType: "A/R", fileName: "ar.pdf", mimeType: null, fileSize: 1, storageUrl: "x", uploadedByName: null } as any);
    await vi.waitFor(() => expect(logInfo).toHaveBeenCalledWith("bi_doc_mirror_skipped", expect.objectContaining({ bfApplicationId: "bf-1", bfDocumentId: "d-1", reason: "no_bi_link" })));
  });

  it("catches up existing documents on BI-linked applications only", async () => {
    query.mockImplementation(answerBySql([
      [/FROM documents d\s+JOIN applications a/, { rows: [
        { id: "d-ar", application_id: "bf-1", category: "A/R", filename: "ar.pdf", size_bytes: 10, blob_url: "u" },
        { id: "d-other", application_id: "bf-1", category: "Other", filename: "o.pdf", size_bytes: 10, blob_url: "u" },
      ] }],
    ]));
    expect(await backfillPgiMirrors(30)).toEqual({ eligible: 1, mirrored: 0 });
    const sql = callsMatching(query, /FROM documents d\s+JOIN applications a/)[0][0] as string;
    expect(sql).toContain("WHERE a.bi_public_id IS NOT NULL");
    expect(sql).toContain("AND d.bi_mirrored_at IS NULL");
    expect(logInfo).toHaveBeenCalledWith("bi_doc_mirror_backfill", { eligible: 1, mirrored: 0 });
  });

  it("runs one catch-up pass a minute after boot", async () => {
    const boot = await bootIndex();
    try {
      await boot.workersDone();
      await vi.waitFor(() => expect(boot.stubs.backfillPgiMirrors).toHaveBeenCalledWith(30));
      expect(boot.timeouts).toContain(60_000);
    } finally { boot.restore(); }
  });

  it("a failed catch-up is logged, not thrown", async () => {
    const boot = await bootIndex({ stubs: { backfillPgiMirrors: async () => { throw new Error("bi down"); } } });
    try {
      await boot.workersDone();
      await vi.waitFor(() => expect(boot.logText("error")).toContain("[startup] pgi mirror backfill failed:"));
    } finally { boot.restore(); }
  });
});
