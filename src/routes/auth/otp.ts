import express, { Request, Response } from "express";
import { ok, fail } from "../../utils/response.js";

const router = express.Router();

type OTPEntry = {
  code: string;
  expires: number;
};

const store: Record<string, OTPEntry> = {};

router.post("/start", (req: Request, res: Response) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json(fail("phone required"));
  }

  const code = "123456";

  store[phone] = {
    code,
    expires: Date.now() + 5 * 60 * 1000
  };

  return res.json(ok({ sent: true }));
});

router.post("/verify", (req: Request, res: Response) => {
  const { phone, code } = req.body;

  const entry = store[phone];

  if (!entry || entry.code !== code) {
    return res.status(400).json(fail("invalid code"));
  }

  return res.json(ok({
    token: "mock-jwt-token",
    nextPath: "/dashboard"
  }));
});

export default router;
