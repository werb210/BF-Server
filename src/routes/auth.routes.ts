import { Router } from 'express';
import { startOtp, verifyOtp, issueToken } from '../services/auth.service';

export const authRoutes = Router();

authRoutes.post('/otp/start', async (req, res) => {
  const { phone } = req.body;

  await startOtp(phone);
  res.json({ success: true });
});

authRoutes.post('/otp/verify', async (req, res) => {
  const { phone, code } = req.body;

  const user = await verifyOtp(phone, code);
  if (!user) return res.status(401).json({ error: 'Invalid OTP' });

  const token = issueToken(user);
  res.json({ token });
});
