import express from "express";
import { ok } from "../lib/respond.js";
import { registry } from "./metrics.js";

const router = express.Router();

router.get("/metrics", async (_req: any, res: any) => {
  res.set("Content-Type", registry.contentType);
  return ok(res, await registry.metrics());
});

export default router;
