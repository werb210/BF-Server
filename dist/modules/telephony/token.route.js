import { Router } from 'express';
const router = Router();
router.get('/token', (_req, res) => {
    return res.status(200).json({
        ok: true,
        token: 'fake-telephony-token'
    });
});
export default router;
