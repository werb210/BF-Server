import { Router } from "express";

const router = Router();

function isPhone(value: unknown): value is string {
  return typeof value === "string" && /^\+?[1-9]\d{7,14}$/.test(value.trim());
}

function isCode(value: unknown): value is string {
  return typeof value === "string" && /^\d{6}$/.test(value.trim());
}

router.post("/otp/start", (req, res) => {
  const { phone } = req.body as { phone?: unknown };

  if (!isPhone(phone)) {
    res.status(400).json({ ok: false, error: "invalid_payload" });
    return;
  }

  res.json({ ok: true, data: { sent: true } });
});

router.post("/otp/verify", (req, res) => {
  const { phone, code, otp } = req.body as { phone?: unknown; code?: unknown; otp?: unknown };

  const validLegacyOtp = otp === undefined || isCode(otp);
  const validContractPayload = isPhone(phone) && isCode(code);

  if (!validLegacyOtp || (!validContractPayload && otp === undefined)) {
    res.status(400).json({ ok: false, error: "invalid_payload" });
    return;
  }

  const token = "dev-token";

  res.setHeader("Set-Cookie", `token=${token}; Path=/; HttpOnly`);
  res.json({
    ok: true,
    token,
    data: { token },
  });
});

export default router;
