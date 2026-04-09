import { Router } from 'express';
const router = Router();
router.get('/', (req, res) => {
    res["json"]({ ok: true });
});
router.post('/', (req, res, _next) => {
    res["json"]({ ok: true });
});
export default router;
