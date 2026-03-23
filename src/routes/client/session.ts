import { Router } from "express";

const router = Router();

router.post("/session/refresh", (_req: any, res: any) => {
  res.status(200).json({ session: null });
});

export default router;
