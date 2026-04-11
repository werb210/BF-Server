import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { runQuery } from "../db.js";

const router = Router();

router.use(requireAuth);

router.get("/", async (_req, res) => {
    try {
        const result = await runQuery(
            `SELECT id, pipeline_state, created_at, updated_at, owner_user_id
             FROM applications
             ORDER BY updated_at DESC
             LIMIT 200`
        );
        res.json({ ok: true, data: result.rows ?? [] });
    } catch {
        res.json({ ok: true, data: [] });
    }
});

router.post("/", (req, res) => {
    res.status(201).json({ ok: true, data: { id: "app-1", ...req.body } });
});

router.get("/:id", async (req, res) => {
    try {
        const result = await runQuery(
            `SELECT * FROM applications WHERE id = $1 LIMIT 1`,
            [req.params.id]
        );
        if (!result.rows[0]) {
            return res.status(404).json({ ok: false, error: "not_found" });
        }
        res.json({ ok: true, data: result.rows[0] });
    } catch {
        res.status(404).json({ ok: false, error: "not_found" });
    }
});

router.get("/:id/documents", (_req, res) => {
    res.json({ ok: true, data: [] });
});

export default router;
