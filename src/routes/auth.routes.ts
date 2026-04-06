import { Router } from "express";
import { body } from "express-validator";
import { login } from "../controllers/auth.controller";

const router = Router();

router.post(
  "/login",
  [body("email").isEmail().withMessage("email must be valid")],
  login
);

export default router;

export function resetOtpStateForTests() {
  // compatibility no-op
}
