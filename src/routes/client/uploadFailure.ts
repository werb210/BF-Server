// BF_SERVER_UPLOAD_DIAG_v751
// POST /api/client/upload-failure - a fire-and-forget beacon from the client portal when an upload
// fails, carrying the browser's own error (name, message, HTTP status if any, size, type, time taken,
// whether the browser thought it was online). Mounted before the client router's ownership checks so
// a failure caused by an expired session can still be reported. Logs one line; stores nothing.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { safeKeyGenerator } from "../../middleware/rateLimit.js";

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);

export function sanitizeUploadFailure(body: any): Record<string, unknown> {
  const appId = str(body?.applicationId, 36);
  const docType = str(body?.documentType, 80);
  return {
    applicationId: appId && /^[0-9a-f-]{36}$/i.test(appId) ? appId : null,
    documentType: docType && /^[a-z0-9_:-]+$/i.test(docType) ? docType : null,
    status: num(body?.status),
    errorName: str(body?.errorName, 40),
    errorMessage: str(body?.errorMessage, 200),
    sizeBytes: num(body?.sizeBytes),
    contentType: str(body?.contentType, 80),
    ms: num(body?.ms),
    online: typeof body?.online === "boolean" ? body.online : null,
    attempt: str(body?.attempt, 20),
  };
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: safeKeyGenerator,
  validate: { xForwardedForHeader: false, trustProxy: false },
});

const router = Router();
router.post("/upload-failure", limiter, (req: any, res: any) => {
  console.warn("[client-upload-failure] " + JSON.stringify(sanitizeUploadFailure(req.body)));
  res.status(204).end();
});
export default router;
