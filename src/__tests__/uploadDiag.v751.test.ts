// BF_SERVER_UPLOAD_DIAG_v751 / BF_SERVER_QUIET_ACTION_CENTER_v751
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { uploadTiming } from "../middleware/uploadTiming.js";
import { sanitizeUploadFailure } from "../routes/client/uploadFailure.js";

function fakeRes(statusCode = 201) { const r: any = new EventEmitter(); r.statusCode = statusCode; return r; }

describe("upload timing log", () => {
  it("logs status, time and size when the upload finishes", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = fakeRes(201); const next = vi.fn();
    uploadTiming({ headers: { "content-length": "2048" } } as any, res, next);
    expect(next).toHaveBeenCalled();
    res.emit("finish"); res.emit("close");
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/\[client-upload\] \{"status":201,"ms":\d+,"bytes":2048\}/);
    log.mockRestore();
  });
  it("says aborted when the browser drops the connection first", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = fakeRes();
    uploadTiming({ headers: {} } as any, res, () => undefined);
    res.emit("close");
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/\[client-upload\] \{"aborted":true,"ms":\d+,"bytes":null\}/);
    warn.mockRestore();
  });
  it("sits in front of the client upload route", () => {
    expect(readFileSync("src/routes/documents.ts", "utf8")).toContain('router.post("/upload", uploadTiming, requireAuth, upload.single("file")');
  });
});

describe("upload-failure beacon", () => {
  it("keeps only safe, bounded fields", () => {
    const out = sanitizeUploadFailure({ applicationId: "724506b6-24bb-4054-a45d-964370564953", documentType: "owner_photo_id", status: 0, errorName: "TypeError",
      errorMessage: "Failed to fetch", sizeBytes: 123456.7, contentType: "application/pdf", ms: 31000, online: true, attempt: "direct", filename: "secret.pdf", phone: "555" });
    expect(out).toEqual({ applicationId: "724506b6-24bb-4054-a45d-964370564953", documentType: "owner_photo_id", status: 0, errorName: "TypeError",
      errorMessage: "Failed to fetch", sizeBytes: 123457, contentType: "application/pdf", ms: 31000, online: true, attempt: "direct" });
    expect(sanitizeUploadFailure({ applicationId: "x; drop", documentType: "<script>" })).toMatchObject({ applicationId: null, documentType: null });
  });
  it("is mounted before the client ownership checks", () => {
    const s = readFileSync("src/routes/client/index.ts", "utf8");
    expect(s.indexOf("router.use(uploadFailureRouter)")).toBeGreaterThan(-1);
    expect(s.indexOf("router.use(uploadFailureRouter)")).toBeLessThan(s.indexOf("router.use((req: any, res: any, next: any) => {"));
  });
});

describe("quiet action-center log", () => {
  it("logs only when an application's counts change", () => {
    const s = readFileSync("src/routes/clientDocumentsNeeded.ts", "utf8");
    expect(s).toContain("if (lastActionCenterCounts.get(applicationId) !== counts) {");
  });
});
