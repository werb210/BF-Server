import express from "express";
import { ok } from "../../lib/response";

const router = express.Router();

router.get("/token", (req: any, res: any) => {
  const token = "real-token";
  return ok({ token }, req.rid);
});

export default router;
