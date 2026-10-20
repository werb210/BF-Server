// BF_SERVER_v837_NO_OCR_FOR_SIGNED_FORMS - Boreal's own signed SBA forms and signed applications are filed without OCR,
// and "Re-run OCR on all documents" no longer re-queues documents that are never read.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ findApplicationById: vi.fn(), listDocuments: vi.fn(), createOcrJob: vi.fn() }));
vi.mock("../modules/applications/applications.repo.js", async () => ({
  ...(await vi.importActual<any>("../modules/applications/applications.repo.js")),
  findApplicationById: h.findApplicationById,
  listDocumentsByApplicationId: h.listDocuments,
}));
vi.mock("../modules/ocr/ocr.repo.js", async () => ({
  ...(await vi.importActual<any>("../modules/ocr/ocr.repo.js")),
  createOcrJob: h.createOcrJob,
}));

import { isNoOcrCategory } from "../routes/documents.js";
import { enqueueOcrForApplication } from "../modules/ocr/ocr.service.js";

beforeEach(() => { h.findApplicationById.mockReset(); h.listDocuments.mockReset(); h.createOcrJob.mockReset(); });

describe("documents that are never OCR'd", () => {
  it("covers Other, SBA forms and signed applications", () => {
    for (const c of ["other", "sba_forms", "signed_application", "Signed Application", " OTHER "]) expect(isNoOcrCategory(c)).toBe(true);
    for (const c of ["bank_statements", "tax_returns", "financial_statements", null]) expect(isNoOcrCategory(c)).toBe(false);
  });

  it("Re-run OCR skips documents marked as not needing OCR", async () => {
    h.findApplicationById.mockResolvedValue({ id: "app-1" });
    h.listDocuments.mockResolvedValue([
      { id: "d1", application_id: "app-1", ocr_status: "skipped" },
      { id: "d2", application_id: "app-1", ocr_status: "completed" },
      { id: "d3", application_id: "app-1", ocr_status: null },
    ]);
    h.createOcrJob.mockImplementation(async ({ documentId }: any) => ({ id: `job-${documentId}` }));
    const jobs = await enqueueOcrForApplication("app-1");
    expect(h.createOcrJob.mock.calls.map((c: any[]) => c[0].documentId)).toEqual(["d2", "d3"]);
    expect(jobs).toHaveLength(2);
  });
});
