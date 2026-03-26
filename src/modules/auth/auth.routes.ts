import { Router, Request, Response } from 'express'
import jwt from "jsonwebtoken";
import { createOtp, verifyOtp, resetOtpStore } from './otpStore'
import { config } from '../../config'

const router = Router()

export function resetOtpStateForTests() {
  resetOtpStore();
}

router.post('/otp/start', (req: Request, res: Response) => {
  const { phone } = req.body

  if (typeof phone !== "string" || phone.trim().length < 7) {
    return res.status(400).json({ error: "invalid_payload" })
  }

  const created = createOtp(phone)

  if (!created.ok) {
    return res.status(created.status).json({ error: created.error })
  }

  return res.status(200).json({
    ok: true,
    data: {
      sent: true,
      otp: config.env === "test" ? created.code : undefined
    }
  })
})

router.post('/otp/verify', (req: Request, res: Response) => {
  const { phone, code } = req.body

  if (typeof phone !== "string" || phone.trim().length < 7 || typeof code !== "string" || code.length !== 6) {
    return res.status(400).json({ error: "invalid_payload" })
  }

  const verified = verifyOtp(phone, code)

  if (!verified.ok) {
    return res.status(verified.status).json({ error: verified.error })
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const token = jwt.sign({ sub: phone, id: phone }, secret)

  return res.status(200).json({ token })
})

router.get('/me', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    user: { id: 'test-user' }
  })
})

router.post('/logout', (_req: Request, res: Response) => {
  return res.status(204).send()
})

export default router
