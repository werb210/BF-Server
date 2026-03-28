import express from 'express'
import { config } from "../../config";

const router = express.Router()

router.get('/token', (req: any, res: any) => {
  if (config.env === 'test') {
    return res.status(200).json({
      success: true,
      data: { token: 'test-token' },
    })
  }

  return res.status(200).json({
    success: true,
    data: { token: 'real-token' },
  })
})

export default router
