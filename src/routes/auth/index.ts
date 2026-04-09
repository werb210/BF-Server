import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";

import otp from "./otp.js";
import { authMeHandler } from "./me.js";
import { auth } from "../../middleware/auth.js";

const router = Router();

router.use("/otp", otp);
router.get("/me", auth, authMeHandler);

// Session refresh — returns a new JWT with a fresh expiry
router.post("/refresh", auth, (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    return res.status(401).json({ status: "error", error: "unauthorized" });
  }

  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    return res.status(500).json({ status: "error", error: "auth_not_configured" });
  }

  const token = jwt.sign(
    {
      sub: user.sub ?? user.userId,
      role: user.role,
      phone: user.phone ?? null,
      tokenVersion: user.tokenVersion ?? 0,
      ...(user.silo ? { silo: user.silo } : {}),
    },
    JWT_SECRET,
    { expiresIn: "1d" },
  );

  return res.status(200).json({ status: "ok", data: { token } });
});

export default router;
