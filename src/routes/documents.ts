import express from "express";
import multer from "multer";
import { ok, fail } from "../utils/response.js";
import { requireAuth } from "../middleware/requireAuth.js";

const upload = multer({ dest: "uploads/" });
const router = express.Router();

let docs = {};

router.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json(fail("Missing file"));

  const id = Date.now().toString();

  docs[id] = {
    id,
    applicationId: req.body.applicationId,
    category: req.body.category,
    filename: req.file.filename,
    status: "uploaded"
  };

  return res.json(ok(docs[id]));
});

router.post("/:id/accept", requireAuth, (req, res) => {
  if (!docs[req.params.id]) return res.status(404).json(fail("Not found"));

  docs[req.params.id].status = "accepted";
  return res.json(ok(docs[req.params.id]));
});

router.post("/:id/reject", requireAuth, (req, res) => {
  const { reason } = req.body;

  if (!docs[req.params.id]) return res.status(404).json(fail("Not found"));

  docs[req.params.id].status = "rejected";
  docs[req.params.id].reason = reason;

  return res.json(ok(docs[req.params.id]));
});

export default router;
