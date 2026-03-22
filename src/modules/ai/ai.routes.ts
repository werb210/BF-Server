import { Router, Request, Response, NextFunction } from 'express';

const router = Router();

router.post(
  '/ai',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // placeholder logic
      return res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
