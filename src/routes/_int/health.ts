import { type Request, type Response, Router } from "express";

export function intHealthHandler(_req: Request, res: Response): void {
  res.json({
    success: true,
    status: "ok",
  });
}

const router = Router();
router.get("/health", intHealthHandler);

export default router;
