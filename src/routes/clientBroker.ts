// BF_SERVER_v865_BROKER_TOOLS - /api/client-broker: what the client app shows and sends for the broker tools. Every route checks
// that the signed-in client owns the application (403 otherwise).
//   GET  /conditions?applicationId=                         the open funding conditions the client must supply
//   POST /conditions/:id/upload   (multipart file, applicationId)   send the document for a condition
//   POST /conditions/:id/done     { applicationId, note? }   mark a condition that needs no document as done
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { safeHandler } from "../middleware/safeHandler.js";
import { callerOwnsApplication } from "../auth/clientApplicationOwnership.js";
import { db, str } from "../brokerTools/common.js";
import { clientView, getCondition, listConditions, signedOfferId } from "../brokerTools/conditions.js";
import { storeConditionDocument } from "./brokerTools.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
const APP_ID = /^[0-9a-f-]{36}$/i;

async function owned(req: Request, res: Response, applicationId: string): Promise<boolean> {
  if (!APP_ID.test(applicationId)) { res.status(400).json({ ok: false, error: "invalid_application_id" }); return false; }
  const ok = await callerOwnsApplication(req, applicationId);
  if (!ok) { res.status(403).json({ ok: false, error: "forbidden" }); return false; }
  return true;
}

router.get("/conditions", safeHandler(async (req: Request, res: Response) => {
  const applicationId = String(req.query.applicationId ?? "").trim();
  if (!(await owned(req, res, applicationId))) return;
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, conditions: clientView(await listConditions(db(), applicationId), await signedOfferId(db(), applicationId)) });
}));

async function clientCondition(applicationId: string, id: string) {
  // BF_SERVER_v947_CONDITIONS_PER_SHEET - only what the client can see in their list can be acted on.
  const visible = clientView(await listConditions(db(), applicationId), await signedOfferId(db(), applicationId));
  if (!visible.some((v) => v.id === id)) return null;
  return getCondition(db(), applicationId, id);
}

router.post("/conditions/:id/upload", upload.single("file"), safeHandler(async (req: Request, res: Response) => {
  const applicationId = String((req.body as any)?.applicationId ?? req.query.applicationId ?? "").trim();
  if (!(await owned(req, res, applicationId))) return;
  const c = await clientCondition(applicationId, String(req.params.id));
  if (!c) return void res.status(404).json({ ok: false, error: "not_found" });
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) return void res.status(400).json({ ok: false, error: "file_required", message: "Choose a file." });
  const doc = await storeConditionDocument(applicationId, file, "client");
  if (!doc.ok) return void res.status(doc.status).json({ ok: false, error: doc.error, message: doc.message });
  await db().query(
    `UPDATE funding_conditions SET document_id = $3, status = 'received', client_submitted_at = now(), updated_at = now()
      WHERE application_id = $1 AND id = $2::uuid`,
    [applicationId, c.id, doc.id],
  );
  res.status(201).json({ ok: true });
}));

router.post("/conditions/:id/done", safeHandler(async (req: Request, res: Response) => {
  const applicationId = String((req.body as any)?.applicationId ?? "").trim();
  if (!(await owned(req, res, applicationId))) return;
  const c = await clientCondition(applicationId, String(req.params.id));
  if (!c) return void res.status(404).json({ ok: false, error: "not_found" });
  if (c.requires_document) return void res.status(400).json({ ok: false, error: "document_required", message: "Upload the document for this item." });
  const note = str((req.body as any)?.note, 2000);
  await db().query(
    `UPDATE funding_conditions SET status = 'received', client_submitted_at = now(),
        note = CASE WHEN $3::text IS NULL THEN note ELSE trim(COALESCE(note || E'\\n', '') || 'Client: ' || $3::text) END, updated_at = now()
      WHERE application_id = $1 AND id = $2::uuid`,
    [applicationId, c.id, note],
  );
  res.json({ ok: true });
}));

export default router;
