import express from 'express'

const router = express.Router()

router.get('/token', (_req: any, res: any) => {
  const token = "real-token";
  return res.status(200).json({
    success: true,
    data: { token },
  })
})

export default router
