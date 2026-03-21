import express from "express";
import { requireAuth } from "../middleware/auth";
import otpRouter from "./auth/otp";
import { authMeHandler } from "./auth/me";

const router = express.Router();

router.use("/otp", otpRouter);
router.get("/me", requireAuth, authMeHandler);
router.post("/logout", (_req, res) => {
  res.clearCookie("token");
  res.clearCookie("accessToken");
  res.status(204).send();
});

export default router;
