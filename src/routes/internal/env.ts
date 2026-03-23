import { Router } from "express";

const router = Router();

router.get("/api/_int/env", (_req: any, res: any) => {
  res.json({
    apiBaseUrl: process.env.API_BASE_URL ?? process.env.CLIENT_URL ?? "http://localhost:3000",
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((v) => v.trim()).filter(Boolean),
  });
});

export default router;
