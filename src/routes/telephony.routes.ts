import { Router } from "express";

const router = Router();

router.get("/token", (_req, res) => {
  res.json({
    ok: true,
    data: { token: "fake-telephony-token" },
  });
});

export default router;
