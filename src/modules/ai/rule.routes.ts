import { Router } from "express";
import { pool } from "../../db";
import { embedAndStore } from "./knowledge.service";

const router = Router();

router.post("/ai/rule", async (req: any, res: any, next: any) => {
  const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";

  if (!content) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  await embedAndStore(pool, content, "rule");

  res.json({ success: true });
});

export default router;
