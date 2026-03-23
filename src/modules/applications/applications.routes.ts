import { Router, Request, Response, NextFunction } from 'express';

const router = Router();

// Example handlers (keep your logic, just typed properly)
router.get('/', (req: Request, res: Response) => {
  res.json({ ok: true });
});

router.post('/', (req: Request, res: Response) => {
  res.json({ ok: true });
});

export default router;
