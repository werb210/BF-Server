import { Router } from 'express';

export async function createServer() {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.status(200).send('OK');
  });

  return router;
}
