import { Router } from "express";

const router = Router();

router.get("/", (_req, res) => {
  res.json({ ok: true, data: [] });
});

router.post("/", (req, res) => {
  res.json({
    ok: true,
    data: { id: "app-1", ...req.body },
  });
});

export default router;
