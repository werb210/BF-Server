import jwt from 'jsonwebtoken';
import { db } from '../db/db';
import { sendOtp, checkOtp } from '../lib/twilio';

export async function startOtp(phone: string) {
  await sendOtp(phone);
}

export async function verifyOtp(phone: string, code: string) {
  const valid = await checkOtp(phone, code);
  if (!valid) return null;

  const result = await db.query(
    'INSERT INTO users (phone) VALUES ($1) ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone RETURNING *',
    [phone]
  );

  return result.rows[0];
}

export function issueToken(user: any) {
  return jwt.sign(
    { id: user.id, phone: user.phone },
    process.env.JWT_SECRET!,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );
}
