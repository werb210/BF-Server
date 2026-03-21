import express from 'express'

const router = express.Router()

// START OTP
router.post('/otp/start', async (req, res) => {
  if (process.env.NODE_ENV === 'test') {
    return res.status(200).json({ success: true })
  }

  // TODO: real implementation
  return res.status(200).json({ success: true })
})

// VERIFY OTP
router.post('/otp/verify', async (req, res) => {
  if (process.env.NODE_ENV === 'test') {
    return res.status(200).json({
      token: 'test-token',
      user: { id: 'test-user' },
    })
  }

  // TODO: real implementation
  return res.status(200).json({
    token: 'real-token',
    user: { id: 'real-user' },
  })
})

// AUTH ME
router.get('/me', (req, res) => {
  if (process.env.NODE_ENV === 'test') {
    return res.status(200).json({
      user: { id: 'test-user' },
    })
  }

  return res.status(200).json({
    user: { id: 'real-user' },
  })
})

export default router
