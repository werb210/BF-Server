import { Router } from "express";
import { dbQuery } from "../db";
import { withTimeout } from "../utils/withTimeout";

const router = Router();

router.post("/", async (req: any, res: any, next: any) => {
  const { email } = req.body as { email?: string };

  if (!email) {
    res.status(400).json({ error: "Email required" });
    return;
  }

  await withTimeout(
    dbQuery(
      `insert into crm_leads (email, source)
       values ($1, 'exit_intent')`,
      [email]
    )
  );

  res.json({ success: true });
});

export default router;
