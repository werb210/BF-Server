// BF_SERVER_BLOCK_v787_EMAIL_REPLY_STOP — poll the sequence reply mailbox
// (SENDGRID_REPLY_TO || SENDGRID_FROM) via Graph and record inbound contact
// replies into communications_messages (direction='inbound', type='email').
// repliedSince() already reads inbound rows, so sequences stop on email reply
// with no engine change. Requires that reply mailbox to be O365-connected
// (server-side OAuth flow already grants Mail.Read + a stored refresh token).
import type { Pool } from "pg";
import { getGraphForUser } from "../modules/o365/graphClient.js";

const TICK_MS = 180_000; // 3 min

type GraphMessage = {
  id?: string;
  internetMessageId?: string;
  from?: { emailAddress?: { address?: string } };
  receivedDateTime?: string;
  bodyPreview?: string;
};

function replyMailbox(): string {
  return String(process.env.SENDGRID_REPLY_TO || process.env.SENDGRID_FROM || "").trim().toLowerCase();
}

async function pollOnce(pool: Pool): Promise<void> {
  const mailbox = replyMailbox();
  if (!mailbox) return;

  const u = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE lower(email) = $1 AND o365_refresh_token IS NOT NULL LIMIT 1`,
    [mailbox],
  );
  const userId = u.rows[0]?.id;
  if (!userId) return; // reply mailbox isn't O365-connected yet

  const graph = await getGraphForUser(pool, userId);
  if (!graph) return;

  const cur = await pool.query<{ last_polled_at: Date }>(
    `SELECT last_polled_at FROM mail_poll_state WHERE mailbox = $1`,
    [mailbox],
  );
  const since = cur.rows[0]?.last_polled_at
    ? new Date(cur.rows[0].last_polled_at)
    : new Date(Date.now() - 24 * 3600 * 1000);
  let maxReceived = since;

  const select = encodeURIComponent("id,internetMessageId,from,receivedDateTime,bodyPreview");
  const filter = encodeURIComponent(`receivedDateTime gt ${since.toISOString()}`);
  const orderby = encodeURIComponent("receivedDateTime asc");
  const resp = await graph.fetch(`/me/mailFolders/inbox/messages?$select=${select}&$filter=${filter}&$orderby=${orderby}&$top=50`);
  if (!resp.ok) return;

  const data = (await resp.json()) as { value?: GraphMessage[] };
  const msgs = Array.isArray(data?.value) ? data.value : [];

  for (const m of msgs) {
    try {
      const received = m.receivedDateTime ? new Date(m.receivedDateTime) : new Date();
      if (received.getTime() > maxReceived.getTime()) maxReceived = received;

      const sender = String(m.from?.emailAddress?.address || "").toLowerCase();
      const msgId = String(m.internetMessageId || m.id || "");
      if (!sender || sender === mailbox || !msgId) continue;

      const c = await pool.query<{ id: string; silo: string }>(
        `SELECT id, silo FROM contacts WHERE lower(email) = $1 ORDER BY created_at LIMIT 1`,
        [sender],
      );
      const contact = c.rows[0];
      if (!contact) continue;

      await pool.query(
        `INSERT INTO communications_messages (type, direction, contact_id, body, created_at, silo, from_number, twilio_sid, read_at)
         VALUES ('email','inbound',$1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (twilio_sid) WHERE twilio_sid IS NOT NULL DO NOTHING`,
        [contact.id, String(m.bodyPreview || "").slice(0, 2000), received, contact.silo || "BF", sender, msgId],
      );
    } catch {
      // Skip malformed or otherwise unprocessable messages; the next poll can continue.
    }
  }

  await pool.query(
    `INSERT INTO mail_poll_state (mailbox, last_polled_at) VALUES ($1,$2)
     ON CONFLICT (mailbox) DO UPDATE SET last_polled_at = EXCLUDED.last_polled_at`,
    [mailbox, maxReceived],
  );
}

export function startMailReplyWorker(pool: Pool): { stop: () => void } {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await pollOnce(pool);
    } catch {
      // Try again on the next scheduled tick.
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, TICK_MS);
  void tick();

  return { stop: () => { stopped = true; clearInterval(timer); } };
}
