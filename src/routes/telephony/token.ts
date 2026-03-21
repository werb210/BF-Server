import express from 'express'

const router = express.Router()

router.get('/token', (req, res) => {
  if (process.env.NODE_ENV === 'test') {
    return res.status(200).json({
      token: 'test-token',
    })
  }

  return res.status(200).json({
    token: 'real-token',
  })
})

export default router
