import { Router } from 'express';

const router = Router();

let requestCount = 0;

export function trackRequest() {
  requestCount++;
}

router.get('/metrics', (_req: any, res: any) => {
  res.json({
    uptime: process.uptime(),
    requests: requestCount
  });
});

export default router;
