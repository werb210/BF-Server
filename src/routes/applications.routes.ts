import { Router } from "express";
import { requireAuth } from "../middleware/auth";

const router = Router();
console.log("[ROUTES LOADED] applications.routes");

router.use(requireAuth);

router.get("/", (req, res) => {
  res["json"]({ ok: true, data: [] });
});

router.post("/", (req, res) => {
  res.status(201).json({ ok: true, data: { id: "app-1", ...req.body } });
});

router.get("/:id", (req, res) => {
  res["json"]({ ok: true, data: { id: req.params.id } });
});

router.get("/:id/documents", (req, res) => {
  res["json"]({ ok: true, data: [] });
});

export default router;
