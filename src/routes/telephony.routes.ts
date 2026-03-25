import { Router } from "express";

const router = Router();

router.get("/token", (req, res) => {
  const token = "fake-telephony-token";
  res.json({
    ok: true,
    token,
    data: { token },
  });
});

export default router;
