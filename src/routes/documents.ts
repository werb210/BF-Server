import express, { Request, Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { fail, ok } from "../lib/response";
import { toStringSafe } from "../utils/toStringSafe";

const router = express.Router();

type Document = {
  id: string;
  status: "uploaded" | "accepted" | "rejected";
  metadata?: any;
};

const db: Record<string, Document> = {};

router.post("/upload", requireAuth, (req: Request, res: Response) => {
  const id = Date.now().toString();

  const doc: Document = {
    id,
    status: "uploaded",
    metadata: req.body
  };

  db[id] = doc;

  return ok(res, doc);
});

router.patch("/:id/accept", requireAuth, (req: Request, res: Response) => {
  const doc = db[toStringSafe(req.params.id)];
  if (!doc) return fail(res, "Not found", 404);

  doc.status = "accepted";
  return ok(res, doc);
});

router.patch("/:id/reject", requireAuth, (req: Request, res: Response) => {
  const doc = db[toStringSafe(req.params.id)];
  if (!doc) return fail(res, "Not found", 404);

  doc.status = "rejected";
  return ok(res, doc);
});

export default router;
