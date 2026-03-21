import express from "express";
import { sendOtp, verifyOtp } from "../auth/otpService";
import { AUTH_CONTRACT } from "../contracts/auth.contract";
import { stripPrefix } from "../contracts/path";

const router = express.Router();

const AUTH_BASE = "/api/auth";

type SessionRequest = {
  session?: {
    user?: unknown;
    [key: string]: unknown;
  };
};

async function otpStartHandler(req: express.Request, res: express.Response) {
  try {
    const { phone } = req.body;

    await sendOtp(phone);

    return res.json({ ok: true });
  } catch (err) {
    console.error("[OTP SEND ERROR]", err);
    return res.status(500).json({ ok: false });
  }
}

async function otpVerifyHandler(req: express.Request, res: express.Response) {
  try {
    const { phone, code } = req.body;

    const result = await verifyOtp(phone, code);

    if (!result.ok) {
      return res.status(400).json(result);
    }

    const sessionRequest = req as unknown as SessionRequest;
    sessionRequest.session = sessionRequest.session || {};
    sessionRequest.session.user = { phone };

    return res.json({ ok: true });
  } catch (err) {
    console.error("[OTP VERIFY ERROR]", err);
    return res.status(500).json({ ok: false });
  }
}

router.post(
  stripPrefix(AUTH_CONTRACT.OTP_START, AUTH_BASE),
  otpStartHandler
);

router.post(
  stripPrefix(AUTH_CONTRACT.OTP_VERIFY, AUTH_BASE),
  otpVerifyHandler
);

export default router;
