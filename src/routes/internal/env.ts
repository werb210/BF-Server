import { Router } from "express";
import { config } from "../../config";
import { API_BASE_URL } from "../../config/api";

const router = Router();

router.get("/api/_int/env", (_req: any, res: any) => {
  res["json"]({
    apiBaseUrl: config.api.baseUrl ?? config.client.url ?? API_BASE_URL,
    allowedOrigins: (config.allowedOrigins ?? "").split(",").map((v: string) => v.trim()).filter(Boolean),
  });
});

export default router;
