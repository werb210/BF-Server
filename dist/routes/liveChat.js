import { Router } from "express";
import { db } from "../db.js";
const router = Router();
router.post("/ai/escalate", async (_req, res) => {
    await db.query(`
      insert into live_chat_queue (status)
      values ('waiting')
    `);
    res["json"]({ status: "queued" });
});
export default router;
