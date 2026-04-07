import { Router } from "express";
import { ok } from "../system/wrap";

const router = Router();

router.get("/", (_req, res) => {
  return ok(res, {
    server: "ok",
    db: "ok",
  });
});

export default router;
