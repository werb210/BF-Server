import express from "express";
import jwt from "jsonwebtoken";
import { ok, fail } from "../../utils/response.js";
import { requireFields } from "../../middleware/validate.js";

const router = express.Router();

let otpStore = {};

router.post("/start", requireFields(["phone"]), (req, res) => {
  const { phone } = req.body;

  const code = "123456"; // dev mode
  otpStore[phone] = code;

  return res.json(ok({ message: "OTP sent" }));
});

router.post("/verify", requireFields(["phone", "code"]), (req, res) => {
  const { phone, code } = req.body;

  if (otpStore[phone] !== code) {
    return res.status(401).json(fail("Invalid OTP"));
  }

  const token = jwt.sign({ phone }, process.env.JWT_SECRET, {
    expiresIn: "1h"
  });

  delete otpStore[phone];

  return res.json(
    ok({
      token,
      user: { phone },
      nextPath: "/dashboard"
    })
  );
});

export default router;
