// BF_SERVER_BLOCK_v220_LAUNCH_FIXES_v1 + HOTFIX_DEPS_v1
// Conversations API for SMS + messenger.
// Outbound-SMS Twilio send happens via the Twilio Node SDK directly so we
// don't depend on a wrapper service whose export shape might drift.
import { Router } from "express";
import { pool } from "../db";
import { requireAuth } from "../middleware/auth";
import twilio from "twilio";

const router = Router();

function twilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return twilio(sid, token);
}

async function sendOutboundSms(to: string, body: string): Promise<void> {
  const client = twilioClient();
  if (!client) {
    console.warn("[conversations] outbound SMS skipped: Twilio creds missing");
    return;
  }
  const from = process.env.TWILIO_DEFAULT_OUTBOUND_CALLER_ID
            || process.env.TWILIO_SMS_FROM
            || process.env.TWILIO_PHONE_NUMBER;
  if (!from) {
    console.warn("[conversations] outbound SMS skipped: no FROM number configured");
    return;
  }
  try {
    await client.messages.create({ to, from, body });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    console.error("[conversations] Twilio send failed", m);
  }
}

router.get("/conversations", requireAuth, async (req, res) => {
  const channel = String(req.query.channel ?? "").trim();
  const silo: string = (res.locals?.silo as string | undefined) ?? "BF";
  const filters: string[] = ["silo = $1"];
  const values: (string | number)[] = [silo];
  let i = 2;
  if (channel) { filters.push(`channel = $${i++}`); values.push(channel); }
  const r = await pool.query(
    `SELECT id, contact_id, contact_name, contact_phone, channel,
            last_message_preview, last_message_at, unread
       FROM communications_conversations
      WHERE ${filters.join(" AND ")}
      ORDER BY last_message_at DESC NULLS LAST, created_at DESC
      LIMIT 500`,
    values
  );
  res.json({ conversations: r.rows });
});

router.get("/conversations/:id/messages", requireAuth, async (req, res) => {
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  const params: (string)[] = [req.params.id];
  let sinceClause = "";
  if (since && !isNaN(since.getTime())) {
    sinceClause = `AND created_at > $2`;
    params.push(since.toISOString());
  }
  const r = await pool.query(
    `SELECT id, conversation_id, channel, direction, body, created_at
       FROM communications_messages
      WHERE conversation_id = $1 ${sinceClause}
      ORDER BY created_at ASC
      LIMIT 1000`,
    params
  );
  res.json({ messages: r.rows });
});

router.post("/conversations/:id/messages", requireAuth, async (req, res) => {
  const conv = await pool.query<{ contact_phone: string | null; channel: string }>(
    `SELECT contact_phone, channel FROM communications_conversations WHERE id = $1`,
    [req.params.id]
  );
  if (conv.rowCount === 0) return res.status(404).json({ error: "conversation_not_found" });
  const channel: string = conv.rows[0].channel;
  const body = String(req.body?.body ?? "").trim();
  if (!body) return res.status(400).json({ error: "missing_body" });

  const ins = await pool.query<{ id: string; created_at: string }>(
    `INSERT INTO communications_messages
       (conversation_id, channel, direction, body, created_at)
     VALUES ($1, $2, 'outbound', $3, NOW())
     RETURNING id, created_at`,
    [req.params.id, channel, body]
  );
  await pool.query(
    `UPDATE communications_conversations
        SET last_message_preview = $2,
            last_message_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [req.params.id, body.slice(0, 200)]
  );

  // For SMS conversations, fire outbound via Twilio.
  if (channel === "sms" && conv.rows[0].contact_phone) {
    void sendOutboundSms(conv.rows[0].contact_phone, body);
  }

  res.status(201).json({
    id: ins.rows[0].id,
    conversation_id: req.params.id,
    channel,
    direction: "outbound",
    body,
    created_at: ins.rows[0].created_at,
  });
});

router.get("/conversations/:id/stream", async (req, res) => {
  const jwt = await import("jsonwebtoken");
  const token = String(req.query.token ?? "");
  try { jwt.verify(token, String(process.env.JWT_SECRET ?? "")); }
  catch { return res.status(401).end(); }

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let lastSeenAt = new Date();
  const interval = setInterval(async () => {
    try {
      const r = await pool.query(
        `SELECT id, conversation_id, channel, direction, body, created_at
           FROM communications_messages
          WHERE conversation_id = $1 AND created_at > $2
          ORDER BY created_at ASC`,
        [req.params.id, lastSeenAt.toISOString()]
      );
      for (const row of r.rows) {
        res.write(`data: ${JSON.stringify(row)}\n\n`);
        lastSeenAt = new Date(row.created_at);
      }
    } catch {
      // swallow — next tick retries
    }
  }, 3000);

  req.on("close", () => clearInterval(interval));
});

export default router;
