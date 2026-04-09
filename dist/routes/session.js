import { Router } from "express";
const router = Router();
router.get("/session", async (req, res, next) => {
    const sessionUser = req.session?.user;
    if (sessionUser) {
        return res["json"]({
            authenticated: true,
            user: sessionUser,
        });
    }
    return res["json"]({
        authenticated: false,
    });
});
router.post("/api/client/session/refresh", async (req, res, next) => {
    const session = req.session;
    if (!session) {
        return res.status(401).json({ error: "No session" });
    }
    return res["json"]({
        success: true,
        session,
    });
});
export default router;
