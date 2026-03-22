import express from "express";
import multer from "multer";
import { ok } from "../utils/response.js";
import { requireAuth } from "../middleware/requireAuth.js";

const upload = multer({ dest: "uploads/" });
const router = express.Router();

type DocumentRecord = {
  id: string;
  applicationId?: string;
  filename?: string;
};

const docs: Record<string, DocumentRecord> = {};

router.post("/upload", upload.single("file"), (req, res) => {
  const id = Date.now().toString();
  docs[id] = {
    id,
    applicationId: req.body.applicationId,
    filename: req.file?.filename,
  };
  return res.json(ok({ id }));
});

router.post("/:id/accept", requireAuth, (_req, res) => {
  return res.json(ok({ status: "accepted" }));
});

router.post("/:id/reject", requireAuth, (req, res) => {
  const { reason } = req.body;
  return res.json(ok({ status: "rejected", reason }));
});

export default router;
