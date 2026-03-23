import { Router, Request, Response, NextFunction } from 'express';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  res.json({ ok: true });
});

router.post('/', (req: Request, res: Response, next: NextFunction) => {
  res.json({ ok: true });
});

export default router;
