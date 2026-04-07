import { Router } from "express";

import otp from "./otp";
import { authMeHandler } from "./me";
import { resetRedisMock } from "../../lib/redis";

const router = Router();

export function resetOtpStateForTests() {
  resetRedisMock();
}

router.use("/otp", otp);
router.get("/me", authMeHandler);

export default router;
