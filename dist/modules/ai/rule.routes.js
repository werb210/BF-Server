import { Router } from "express";
import { pool } from "../../db.js";
import { embedAndStore } from "./knowledge.service.js";
const router = Router();
router.post("/ai/rule", async (req, res, next) => {
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!content) {
        res.status(400).json({ error: "content is required" });
        return;
    }
    await embedAndStore(pool, content, "rule");
    res["json"]({ success: true });
});
export default router;
