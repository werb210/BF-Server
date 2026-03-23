import { Router, Request, Response } from 'express'
import { createOtp, verifyOtp } from './otpStore'
import { isTest, runtimeEnv } from '../../server/config/config'

const router = Router()

router.post('/api/auth/otp/start', (req: Request, res: Response) => {
  const { phone } = req.body

  if (!phone) {
    return res.status(400).json({ ok: false })
  }

  const code = createOtp(phone)

  return res.status(200).json({
    ok: true,
    data: {
      sent: true,
      otp: runtimeEnv.isTest ? code : undefined
    }
  })
})

router.post('/api/auth/otp/verify', (req: Request, res: Response) => {
  const { phone, code } = req.body

  const valid = verifyOtp(phone, code)

  if (!valid) {
    return res.status(400).json({ ok: false })
  }

  return res.status(200).json({
    ok: true,
    token: 'test-token'
  })
})

router.get('/api/auth/me', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    user: { id: 'test-user' }
  })
})

router.post('/api/auth/logout', (_req: Request, res: Response) => {
  return res.status(204).send()
})

export default router
