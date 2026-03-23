import { toStringSet } from "../utils/collectionSafe";
import { Router } from "express";
import { retry, withRetry } from "../utils/retry";
import { createSupportThread } from "../services/supportService";
import { dbQuery } from "../db";
import { twilioClient } from "../services/twilio";
import { pushLeadToCRM } from "../services/crmWebhook";
import { SupportController } from "../modules/support/support.controller";
import { logger } from "../server/utils/logger";

const router = Router();

const tableColumnCache = new Map<string, Set<string>>();

async function getTableColumns(table: string): Promise<Set<string>> {
  const cached = tableColumnCache.get(table);
  if (cached) {
    return cached;
  }
  const { rows } = await dbQuery<{ column_name: string }>(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`,
    [table]
  );
  const columns = toStringSet(rows.map((row) => row.column_name));
  tableColumnCache.set(table, columns);
  return columns;
}

router.post("/live", async (req: any, res: any, next: any) => {
  const { source, sessionId } = req.body as {
    source?: "website" | "client";
    sessionId?: string;
  };

  if (!source || !sessionId) {
    return res.status(400).json({ error: "Missing source or sessionId" });
  }

  await dbQuery(
    `insert into live_chat_requests (source, session_id, status)
     values ($1, $2, 'pending')`,
    [source, sessionId]
  );

  return res.json({ success: true });
});

router.get("/live", async (_req: any, res: any) => {
  const { rows } = await dbQuery(
    `select id, source, session_id, status, created_at
     from live_chat_requests
     where status = 'pending'
     order by created_at desc`
  );
  res.json(rows);
});

router.get("/live/count", async (_req: any, res: any) => {
  const { rows } = await dbQuery<{ count: string }>(
    `select count(*)::text as count
     from live_chat_requests
     where status = 'pending'`
  );
  res.json({ count: Number(rows[0]?.count ?? "0") });
});

router.post("/human", async (req: any, res: any, next: any) => {
  const { message, user } = req.body as {
    message?: string;
    user?: string;
  };

  await withRetry(async () => {
    await createSupportThread({
      type: "chat_escalation",
      description: message ?? "Human support request",
      source: user ?? "unknown",
    });
  });

  logger.info("human_chat_request", { message });
  res.json({ success: true });
});

router.post("/report", async (req: any, res: any, next: any) => {
  const { message, description, screenshot, route } = req.body as {
    message?: string;
    description?: string;
    screenshot?: string;
    route?: string;
  };

  const resolvedDescription = description ?? message;

  const columns = await getTableColumns("issue_reports");

  const insertColumns: string[] = [];
  const placeholderParts: string[] = [];
  const values: unknown[] = [];

  if (columns.has("id")) {
    insertColumns.push("id");
    placeholderParts.push("gen_random_uuid()");
  }

  const pushValue = (column: string, value: unknown): void => {
    if (!columns.has(column)) {
      return;
    }
    insertColumns.push(column);
    values.push(value);
    placeholderParts.push(`$${values.length}`);
  };

  pushValue("description", resolvedDescription ?? "Issue reported");
  pushValue("screenshot_base64", screenshot ?? null);
  pushValue("user_agent", (req.headers["user-agent"] as string | undefined) ?? "unknown");
  pushValue("page_url", route ?? "unknown");
  pushValue("browser_info", (req.headers["user-agent"] as string | undefined) ?? "unknown");
  pushValue("screenshot_path", screenshot ?? null);
  pushValue("status", "open");

  if (insertColumns.length === 0) {
    await dbQuery("insert into issue_reports default values");
  } else {
    await dbQuery(
      `insert into issue_reports (${insertColumns.join(", ")}) values (${placeholderParts.join(", ")})`,
      values
    );
  }

  await withRetry(async () => {
    await createSupportThread({
      type: "issue_report",
      ...(resolvedDescription ? { description: resolvedDescription } : {}),
      ...(screenshot ? { screenshotBase64: screenshot } : {}),
      ...(route ? { route } : {}),
    });
  });

  logger.info("issue_reported", { description: resolvedDescription ?? null });
  res.json({ success: true });
});

router.post("/contact", async (req: any, res: any, next: any) => {
  const { company, firstName, lastName, email, phone } = req.body as {
    company?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  };

  if (!company || !firstName || !lastName || !email || !phone) {
    return res.status(400).json({ error: "Missing fields" });
  }

  await dbQuery(
    `insert into contact_leads (company, first_name, last_name, email, phone)
     values ($1, $2, $3, $4, $5)`,
    [company, firstName, lastName, email, phone]
  );

  const client = twilioClient();
  await retry(async () =>
    client.messages.create({
      body: `New Contact: ${company} - ${firstName} ${lastName} - ${phone}`,
      from: process.env.TWILIO_PHONE as string,
      to: "+15878881837",
    })
  );

  await pushLeadToCRM({
    type: "contact_form",
    company,
    firstName,
    lastName,
    email,
    phone,
  });

  return res.json({ success: true });
});

router.post("/track", async (req: any, res: any, next: any) => {
  const { event, metadata } = req.body as {
    event?: string;
    metadata?: Record<string, unknown>;
  };

  logger.info("support_track_event", { event: event ?? null, metadata: metadata ?? null });
  return res.json({ success: true });
});

router.post("/session", SupportController.createSession);
router.get("/queue", SupportController.getQueue);
router.post("/issue", SupportController.createIssue);
router.get("/issues", SupportController.getIssues);
router.post("/event", SupportController.trackEvent);
router.get("/events", SupportController.getEvents);

export default router;
