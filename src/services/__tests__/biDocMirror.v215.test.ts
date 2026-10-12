// BF_SERVER_BLOCK_v215_BF_TO_BI_DOC_MIRROR_v1
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const queryMock = vi.fn();
vi.mock("../../db.js", () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));
vi.mock("../../observability/logger.js", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

import { mirrorDocToBi, resolveBiPublicId } from "../biDocMirror.js";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js"; // BF_SERVER_v789 SQL-content mocks

const ORIG_FETCH = global.fetch;

function baseInput() {
  return {
    bfApplicationId: "bf-app-1",
    bfDocumentId: "bf-doc-1",
    documentType: "bank_statement",
    fileName: "march.pdf",
    mimeType: "application/pdf",
    fileSize: 12345,
    storageUrl: "https://bf-blob.example/abc",
    uploadedByName: null,
  };
}

describe("BF_SERVER_BLOCK_v215 — biDocMirror.resolveBiPublicId", () => {
  beforeEach(() => queryMock.mockReset());

  it("returns the BI public id when the BF app has a link", async () => {
    queryMock.mockImplementation(answerBySql([[/bi_public_id/, { rows: [{ bi_public_id: "pub-xyz" }] }]]));
    const pid = await resolveBiPublicId("bf-app-1");
    expect(pid).toBe("pub-xyz");
  });

  it("returns null when no BI link exists", async () => {
    queryMock.mockImplementation(answerBySql([[/bi_public_id/, { rows: [{ bi_public_id: null }] }]]));
    const pid = await resolveBiPublicId("bf-app-1");
    expect(pid).toBeNull();
  });

  it("returns null when the BF app row does not exist", async () => {
    queryMock.mockImplementation(answerBySql([[/bi_public_id/, { rows: [] }]]));
    const pid = await resolveBiPublicId("bf-app-1");
    expect(pid).toBeNull();
  });
});

describe("BF_SERVER_BLOCK_v215 — biDocMirror.mirrorDocToBi", () => {
  beforeEach(() => {
    queryMock.mockReset();
    process.env.JWT_SECRET = "test-shared-secret-min-10";
    process.env.BI_SERVER_URL = "https://bi.test.local";
  });
  afterEach(() => {
    global.fetch = ORIG_FETCH;
  });

  it("returns ok=false 'no_jwt_secret' when JWT_SECRET missing", async () => {
    delete process.env.JWT_SECRET;
    const r = await mirrorDocToBi(baseInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("no_jwt_secret");
  });

  it("returns ok=false 'no_bi_link' when BF app has no BI link", async () => {
    queryMock.mockImplementation(answerBySql([[/bi_public_id/, { rows: [{ bi_public_id: null }] }]]));
    const r = await mirrorDocToBi(baseInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("no_bi_link");
  });

  it("POSTs to the BI endpoint and returns ok=true on success", async () => {
    queryMock.mockImplementation(answerBySql([[/bi_public_id/, { rows: [{ bi_public_id: "pub-xyz" }] }]]));
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ ok: true, bi_document_id: "bi-doc-1", bi_application_id: "bi-app-1" }),
      text: async () => "",
    });
    global.fetch = fetchSpy as any;
    const r = await mirrorDocToBi(baseInput());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.biDocumentId).toBe("bi-doc-1");
      expect(r.biApplicationId).toBe("bi-app-1");
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchSpy.mock.calls[0][0]);
    expect(calledUrl).toContain("/api/v1/bi/applications/pub-xyz/documents/from-bf");
  });

  it("returns ok=false when BI responds non-2xx", async () => {
    queryMock.mockImplementation(answerBySql([[/bi_public_id/, { rows: [{ bi_public_id: "pub-xyz" }] }]]));
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false, status: 500, json: async () => ({}), text: async () => "boom",
    }) as any;
    const r = await mirrorDocToBi(baseInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bi_500");
  });

  it("returns ok=false on transport exception", async () => {
    queryMock.mockImplementation(answerBySql([[/bi_public_id/, { rows: [{ bi_public_id: "pub-xyz" }] }]]));
    global.fetch = vi.fn().mockRejectedValueOnce(new Error("network down")) as any;
    const r = await mirrorDocToBi(baseInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bi_exception");
  });

  it("propagates idempotent flag from BI when set", async () => {
    queryMock.mockImplementation(answerBySql([[/bi_public_id/, { rows: [{ bi_public_id: "pub-xyz" }] }]]));
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ ok: true, idempotent: true, bi_document_id: "bi-doc-1", bi_application_id: "bi-app-1" }),
      text: async () => "",
    }) as any;
    const r = await mirrorDocToBi(baseInput());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.idempotent).toBe(true);
  });
});
