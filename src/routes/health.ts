import { Router } from 'express';
import { testDbConnection } from '../lib/dbClient';

const router = Router();

router.get('/health', async (_req: any, res: any) => {
  const dbOk = await testDbConnection();

  res.status(dbOk ? 200 : 500).json({
    status: dbOk ? 'ok' : 'fail',
    db: dbOk
  });
});

export default router;
