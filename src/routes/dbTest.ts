import { Router } from 'express';
import { pool } from '../lib/dbClient';

const router = Router();

router.get('/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as now');
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_failed' });
  }
});

export default router;
