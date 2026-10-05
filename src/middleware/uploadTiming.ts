// BF_SERVER_UPLOAD_DIAG_v751
// One log line per client document upload: status, time taken and size. When the browser drops the
// connection before the server answers, the line says aborted:true, which is what an applicant sees
// as "No connection right now" even though their file may already be on its way. No file names.
import type { NextFunction, Request, Response } from "express";

export type UploadTimingLine = { status?: number; aborted?: true; ms: number; bytes: number | null };

export function uploadTiming(req: Request, res: Response, next: NextFunction): void {
  const t0 = Date.now();
  const raw = Number(req.headers["content-length"] ?? 0);
  const bytes = Number.isFinite(raw) && raw > 0 ? raw : null;
  let finished = false;
  res.on("finish", () => {
    finished = true;
    const line: UploadTimingLine = { status: res.statusCode, ms: Date.now() - t0, bytes };
    console.log("[client-upload] " + JSON.stringify(line));
  });
  res.on("close", () => {
    if (finished) return;
    const line: UploadTimingLine = { aborted: true, ms: Date.now() - t0, bytes };
    console.warn("[client-upload] " + JSON.stringify(line));
  });
  next();
}
