import express from "express";
import jwt from "jsonwebtoken";
import { ok, fail } from "../../utils/response.js";

const router = express.Router();

router.post("/start", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json(fail("Missing phone"));

  return res.json(ok({ message: "OTP sent" }));
});

router.post("/verify", async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json(fail("Missing fields"));

  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json(fail("JWT secret not configured", 500));

  const token = jwt.sign({ phone }, secret, { expiresIn: "1h" });

  return res.json(
    ok({
      token,
      user: { phone },
      nextPath: "/dashboard",
    })
  );
});

export default router;
