import { Router } from 'express'

const router = Router()

router.get('/token', (_req: any, res: any) => {
  return res.status(200).json({
    ok: true,
    token: 'fake-telephony-token'
  })
})

export default router
