import { Router } from "express";
import { randomUUID } from "node:crypto";
import { dbQuery } from "../db";

const router = Router();

router.post("/", async (req: any, res: any, next: any) => {
  const { message, screenshot, pageUrl, browserInfo, sessionId, url } = req.body as {
    message?: string;
    screenshot?: string;
    pageUrl?: string;
    browserInfo?: string;
    sessionId?: string;
    url?: string;
  };

  if (!message && !url) {
    return res.status(400).json({ error: "Message or url required" });
  }

  await dbQuery(
    `insert into issue_reports
      (id, session_id, description, page_url, browser_info, screenshot_path, screenshot_base64, user_agent, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'open')`,
    [
      randomUUID(),
      sessionId ?? null,
      message ?? "Issue reported",
      pageUrl ?? url ?? "unknown",
      browserInfo ?? "unknown",
      screenshot ?? null,
      screenshot ?? null,
      req.headers["user-agent"] ?? "",
    ]
  );

  return res.json({ success: true });
});

export default router;
