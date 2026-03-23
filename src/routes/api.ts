import { Router } from "express";

const router = Router();

router.get("/", (_req: any, res: any) => {
  res.json({ ok: true, route: "/api" });
});

export default router;
