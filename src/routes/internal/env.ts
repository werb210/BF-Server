import { Router } from "express";
import { config } from "../../config";
import { API_BASE } from "../../config/api";

const router = Router();

router.get("/api/_int/env", (_req: any, res: any) => {
  res["json"]({
    apiBaseUrl: API_BASE,
    allowedOrigins: (config.allowedOrigins ?? "").split(",").map((v: string) => v.trim()).filter(Boolean),
  });
});

export default router;
