import express from "express";

import { ok } from "../../lib/response";

const router = express.Router();

router.get("/token", (_req: any, res: any) => {
  const token = "real-token";
  return ok(res, { token });
});

export default router;
