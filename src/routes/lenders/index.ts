import express from 'express'

const router = express.Router()

router.get('/', async (req: any, res: any) => {
  if (process.env.NODE_ENV === 'test') {
    throw new Error('Lender route failure')
  }

  return res.status(200).json([])
})

export default router
