import express from 'express';
const router = express.Router();

router.post('/otp/start', async (req, res, next) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ message: 'Missing phone' });
  }

  return res.status(200).json({ success: true });
});

router.post('/otp/verify', async (req, res, next) => {
  const { phone, code } = req.body;

  if (!phone || !code) {
    return res.status(400).json({ message: 'Invalid payload' });
  }

  res.cookie('session', 'valid', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === "production",
  });

  return res.status(200).json({ user: { id: '1' } });
});

export default router;
