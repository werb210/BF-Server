import { Router } from "express";

const router = Router();

router.get("/", (req, res) => {
  res.json({ ok: true, data: [] });
});

router.post("/", (req, res) => {
  res.status(201).json({ ok: true, data: { id: "app-1", ...req.body } });
});

router.get("/:id", (req, res) => {
  res.json({ ok: true, data: { id: req.params.id } });
});

router.get("/:id/documents", (req, res) => {
  res.json({ ok: true, data: [] });
});

export default router;
