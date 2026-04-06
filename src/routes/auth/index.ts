import { Router } from "express";

import otp from "./otp";
import { authMeHandler } from "./me";

const router = Router();

export function resetOtpStateForTests() {
  // OTP persistence is external/no-op for this router.
}

router.use("/otp", otp);
router.get("/me", authMeHandler);

export default router;
