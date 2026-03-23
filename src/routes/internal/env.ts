import { Router } from "express";
import { config } from "@/config";

const router = Router();

router.get("/api/_int/env", (_req: any, res: any) => {
  res.json({
    apiBaseUrl: config.api.baseUrl ?? config.client.url ?? "http://localhost:3000",
    allowedOrigins: (config.allowedOrigins ?? "").split(",").map((v) => v.trim()).filter(Boolean),
  });
});

export default router;
