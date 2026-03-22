import express, { Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../utils/response.js";
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

  return res.json(ok(doc));
});

router.patch("/:id/accept", requireAuth, (req: Request, res: Response) => {
  const doc = db[toStringSafe(req.params.id)];
  if (!doc) return res.status(404).json(fail("Not found"));

  doc.status = "accepted";
  return res.json(ok(doc));
});

router.patch("/:id/reject", requireAuth, (req: Request, res: Response) => {
  const doc = db[toStringSafe(req.params.id)];
  if (!doc) return res.status(404).json(fail("Not found"));

  doc.status = "rejected";
  return res.json(ok(doc));
});

export default router;
