import express from "express";
import { ok } from "../../lib/respond.js";
const router = express.Router();
router.get("/token", (req, res) => {
    const token = "real-token";
    return ok(res, { token });
});
export default router;
