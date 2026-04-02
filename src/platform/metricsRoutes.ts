import express from "express";
import { registry } from "./metrics";

const router = express.Router();

router.get("/metrics", async (_req: any, res: any) => {
  res.set("Content-Type", registry.contentType);
  return res.json(await registry.metrics());
});

export default router;
