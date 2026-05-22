import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireAuthorization } from '../../middleware/auth.js';
import { ROLES } from '../../auth/roles.js';

const router = Router();

router.post(
  '/ai',
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }), // v619:
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // placeholder logic
      return res["json"]({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
