import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";

import otp from "./otp.js";
import { authMeHandler } from "./me.js";
import { auth } from "../../middleware/auth.js";

const router = Router();

router.use("/otp", otp);
router.get("/me", auth, authMeHandler);

router.post("/refresh", auth, (req: Request, res: Response) => {
  const user = (req as any).user;

  const token = jwt.sign(
    {
      sub: user.sub,
      role: user.role,
      phone: user.phone ?? null,
      tokenVersion: user.tokenVersion ?? 0,
      ...(user.silo ? { silo: user.silo } : {}),
    },
    process.env.JWT_SECRET!,
    { expiresIn: "1d" },
  );

  res.json({ status: "ok", data: { token } });
});

export default router;
