import { Router } from "express";
import { blobStorage } from "../services/storage/blobStorage";

const router = Router();

router.get("/health", async (_req: any, res: any) => {
  const ok = await blobStorage.pingStorage();
  res.json({ status: ok ? "ok" : "fail" });
});

export default router;
