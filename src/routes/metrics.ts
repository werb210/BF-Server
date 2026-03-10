import express from "express";
import { registry } from "../metrics/registry";

const router = express.Router();

router.get("/", async (_req, res) => {
  res.set("Content-Type", registry.contentType);
  res.end(await registry.metrics());
});

export default router;
