import { Router } from "express";
const router = Router();
router.get("/test", (_req, res) => {
    return res.status(200).json({ success: true });
});
export default router;
