import express from 'express'
import { config } from "../../config";

const router = express.Router()

router.get('/', async (req: any, res: any) => {
  if (config.env === 'test') {
    throw new Error('Lender route failure')
  }

  return res.status(200).json([])
})

export default router
