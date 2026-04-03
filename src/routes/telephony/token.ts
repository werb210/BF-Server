import express from "express";
import { ok } from "@/lib/respond";

const router = express.Router();

router.get("/token", (req: any, res: any) => {
  const token = "real-token";
  return ok(res, { token });
});

export default router;
