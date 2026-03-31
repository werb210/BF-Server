import { Router } from 'express';
import { pool } from '../db/client';

const router = Router();

router.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok' });
  } catch {
    res.status(500).json({ status: 'db_down' });
  }
});

export default router;
