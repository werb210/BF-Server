import { Router } from "express";
import { requireAuth, requireAuthorization, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { verifyAccessToken } from "../auth/jwt.js"; // BF_SERVER_SMS_MEDIA_v1
import { fetchTwilioMedia, persistTwilioMediaToBlob } from "../services/mmsMedia.js"; // BF_SERVER_MMS_BLOB_PROXY_v1
import twilio from "twilio";

const router = Router();

// BF_SERVER_MEDIA_QUERY_AUTH_v1 - <img>/<audio> elements cannot send an
// Authorization header, so media/recording proxy routes carry the access token
// in a ?token= query param. This runs BEFORE router.use(requireAuth): for those
// paths it promotes the query token into a Bearer header so the normal auth and
// capability checks still apply. Non-media routes are untouched. This is what
// makes inbound MMS images and call-recording <audio> actually load.
router.use((req: any, _res: any, next: any) => {
  const p = String(req.path || "");
  const isMedia = /\/media$/.test(p) && (/\/messages\//.test(p) || /\/recordings\//.test(p));
  if (isMedia && !req.headers.authorization) {
    const t = String(req.query?.token ?? "");
    if (t) req.headers.authorization = "Bearer " + t;
  }
  next();
});

// BF_SERVER_BLOCK_v736_MERGE_TOKENS_SMS_MSG - substitute {{first_name}} (and other
// tokens) on SMS / messenger sends, the same way email (o365 v705) already does.
function renderMergeTokensComm(t: string, ctx: Record<string, string>): string {
  return String(t ?? "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m: string, k: string) => {
    const v = ctx[k];
    return v != null ? String(v) : "";
  });
}
async function mergeCtxForContact(opts: { contactId?: string | null; phone?: string | null }): Promise<Record<string, string>> {
  const ctx: Record<string, string> = { first_name: "there", last_name: "", full_name: "", name: "" };
  try {
    let row: { first_name: string | null; last_name: string | null; name: string | null } | undefined;
    if (opts.contactId) {
      const r = await pool.query<{ first_name: string | null; last_name: string | null; name: string | null }>(
        `SELECT first_name, last_name, name FROM contacts WHERE id::text = $1 LIMIT 1`, [opts.contactId]);
      row = r.rows[0];
    }
    if (!row && opts.phone) {
      const last10 = String(opts.phone).replace(/[^0-9]/g, "").slice(-10);
      if (last10) {
        const r = await pool.query<{ first_name: string | null; last_name: string | null; name: string | null }>(
          `SELECT first_name, last_name, name FROM contacts
            WHERE right(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), 10) = $1
            ORDER BY updated_at DESC LIMIT 1`, [last10]);
        row = r.rows[0];
      }
    }
    if (row) {
      const fn = (row.first_name ?? "").trim() || (row.name ?? "").trim().split(/\s+/)[0] || "";
      if (fn) ctx.first_name = fn;
      ctx.last_name = (row.last_name ?? "").trim();
      ctx.name = (row.name ?? "").trim();
      ctx.full_name = (row.name ?? "").trim() || `${fn} ${ctx.last_name}`.trim();
    }
  } catch { /* best-effort */ }
  return ctx;
}
router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.COMMUNICATIONS_READ]));

router.post("/call-events", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId ?? null;
  const { getSilo } = await import("../middleware/silo.js");
  const silo = getSilo(res);
  const body = req.body ?? {};
  const eventType = typeof body.event_type === "string" ? body.event_type : "";
  const toNumber = typeof body.to_number === "string" ? body.to_number : "";
  if (!eventType || !toNumber) return res.status(400).json({ error: "event_type and to_number are required" });
  // BF_SERVER_BLOCK_v708 - when the client doesn't thread contact_id, resolve it
  // by matching the call's numbers (last 10 digits) to a contact in this silo.
  let contactId: string | null = body.contact_id ?? null;
  if (!contactId) {
    const cand = [toNumber, body.from_number]
      .map((n: any) => String(n || "").replace(/\D/g, "").slice(-10))
      .filter((d: string) => d.length === 10);
    if (cand.length) {
      const cm = await pool.query<{ id: string }>(
        `SELECT id FROM contacts WHERE silo = $1 AND right(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), 10) = ANY($2::text[]) LIMIT 1`,
        [silo, cand],
      );
      contactId = cm.rows[0]?.id ?? null;
    }
  }
  const { rows } = await pool.query(`INSERT INTO call_events (user_id, contact_id, application_id, silo, event_type, direction, from_number, to_number, twilio_call_sid, duration_seconds, error_code, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING id, occurred_at`,
    [userId, contactId, body.application_id ?? null, silo, eventType, body.direction ?? null, body.from_number ?? null, toNumber, body.twilio_call_sid ?? null, body.duration_seconds ?? null, body.error_code ?? null, JSON.stringify(body.payload ?? {})]);
  // BF_SERVER_BLOCK_v822_BI_OUTBOUND_CONTACTED - a BI outbound call advances the contact to
  // "contacted" (matched by dialed number; only from an earlier stage, so it never downgrades
  // engaged/demo_booked/onboarding/active, and re-firing on later call events is a no-op).
  if (silo === "BI" && String(body.direction ?? "").toLowerCase() !== "inbound") {
    const d10 = String(toNumber || "").replace(/\D/g, "").slice(-10);
    if (d10.length === 10) {
      try {
        await pool.query(
          `UPDATE bi_contacts SET outreach_status = 'contacted', outreach_updated_at = NOW()
            WHERE right(regexp_replace(coalesce(phone_e164, ''), '[^0-9]', '', 'g'), 10) = $1
              AND (outreach_status IS NULL OR outreach_status IN ('cold','new','attempting','voicemail'))`,
          [d10],
        );
      } catch (err) {
        console.warn("[communications] BI outbound-call contacted-advance failed", { err: String(err) });
      }
    }
  }
  return res.status(201).json(rows[0]);
}));

router.get("/call-events", safeHandler(async (req: any, res: any) => {
  const { getSilo } = await import("../middleware/silo.js");
  const silo = getSilo(res);
  const clauses = ["silo = $1"];
  const params: any[] = [silo];
  if (typeof req.query.contact_id === "string" && req.query.contact_id) { params.push(req.query.contact_id); clauses.push(`contact_id = $${params.length}`); }
  if (typeof req.query.application_id === "string" && req.query.application_id) { params.push(req.query.application_id); clauses.push(`application_id = $${params.length}`); }
  if (typeof req.query.since === "string" && req.query.since) { params.push(req.query.since); clauses.push(`occurred_at >= $${params.length}::timestamptz`); }
  const { rows } = await pool.query(`SELECT id, user_id, contact_id, application_id, silo, event_type, direction, from_number, to_number, twilio_call_sid, duration_seconds, error_code, payload, occurred_at FROM call_events WHERE ${clauses.join(" AND ")} ORDER BY occurred_at DESC LIMIT 500`, params);
  return res.status(200).json({ events: rows });
}));


// BF_SERVER_BLOCK_v115_MAYA_HANDOFF_v1
// Called by the agent's escalate.to_human tool. Persists the
// handoff into maya_escalations + communications_messages (so
// staff see it in the Messages tab with the maya_handoff filter
// landed in Block 114) and fans Twilio SMS to either currently-
// available staff or the after-hours fallback list from env.
router.post(
  "/maya-handoff",
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any) => {
    const { randomUUID } = await import("node:crypto");
    const body = req.body ?? {};
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.slice(0, 200) : null;
    const surface = typeof body.surface === "string" ? body.surface.slice(0, 50) : "unknown";
    const silo = typeof body.silo === "string" ? body.silo.slice(0, 10) : "BF";
    const summary = typeof body.summary === "string" ? body.summary.slice(0, 1000) : null;
    const recipientsRaw = body.recipients === "available" || body.recipients === "fallback"
      ? body.recipients
      : null;
    if (!recipientsRaw) {
      return res.status(400).json({ error: "recipients_required", allowed: ["available", "fallback"] });
    }

    const { sendStaffNotification } = await import("../services/notifications/staffSms.js");

    // BF_SERVER_BLOCK_v636_MESSAGES_TAB_FIXES_v1: resolve contact + application
    // so handoff rows surface in /messages-list (which groups by contact_id /
    // application_id). Without this they fell into the NULL bucket and the
    // portal MessagesTab dropped them via `.filter((c) => c.id)`.
    const phoneRaw = typeof body.phone === "string" ? body.phone : null;
    const phoneDigits = phoneRaw ? phoneRaw.replace(/\D/g, "").slice(-10) : null;
    const contactIdHint = typeof body.contactId === "string" ? body.contactId : null;
    const applicationIdHint = typeof body.applicationId === "string" ? body.applicationId : null;

    let resolvedContactId: string | null = contactIdHint;
    if (!resolvedContactId && phoneDigits && phoneDigits.length >= 10) {
      const ph = await pool.query<{ id: string }>(
        `SELECT id FROM contacts
          WHERE right(regexp_replace(coalesce(phone,''), '\D', '', 'g'), 10) = $1
          ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1`,
        [phoneDigits],
      ).catch(() => ({ rows: [] as { id: string }[] }));
      resolvedContactId = ph.rows[0]?.id ?? null;
    }
    if (!resolvedContactId && applicationIdHint) {
      const ar = await pool.query<{ contact_id: string | null }>(
        `SELECT contact_id FROM applications WHERE id::text = $1 LIMIT 1`,
        [applicationIdHint],
      ).catch(() => ({ rows: [] as { contact_id: string | null }[] }));
      resolvedContactId = ar.rows[0]?.contact_id ?? null;
    }

    const id = randomUUID();
    await pool.query(
      `INSERT INTO maya_escalations
         (id, session_id, application_id, reason, surface, silo, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [id, sessionId, applicationIdHint, `handoff_${recipientsRaw}`, surface, silo,
       JSON.stringify({ summary, recipients: recipientsRaw, contact_id: resolvedContactId, phone: phoneDigits })],
    );

    // BF_SERVER_BLOCK_v763_MAYA_COMMS_SEPARATION - Maya's own auto-handoff no
    // longer writes a row into communications_messages (it used to pollute the
    // Messages tab with anonymous "Website Visitor" / Maya-transcript entries).
    // The handoff is recorded in maya_escalations and staff are pinged by SMS;
    // the full Maya conversation is viewable in the Maya tab (chat_sessions).

    const smsBody = `Maya handoff (${surface}): ${summary ?? "visitor requested human"}. Session ${sessionId ?? "n/a"}.`;
    const fanout = await sendStaffNotification({ recipients: recipientsRaw, body: smsBody });

    return res.status(200).json({ status: "ok", id, fanout });
  }),
);

router.get("/", safeHandler((_req: any, res: any) => {
  res.json({ status: "ok" });
}));

// GET /api/communications/messages - queries the actual DB.
// BF_SERVER_v65_COMMS_NO_400 - when contact_id is absent, return an empty
// list with 200 instead of 400. Portal Communications page calls this
// before any thread is selected; the previous 400 just spammed the
// console without changing the rendered empty-state.
// BF_SERVER_BLOCK_83_SMS_MESSAGES_TYPE_FILTER_v1 - Messages tab is the
// in-portal channel (system handoffs like the PGI ready-to-complete
// link; future internal notes/email/etc). Exclude 'sms' so Twilio
// rows stay in their own tab. type column is text, NULL legacy rows
// fall through into Messages (default behaviour).
router.get("/messages", safeHandler(async (req: any, res: any) => {
  const contactId =
    (typeof req.query.contact_id === "string" && req.query.contact_id) ||
    (typeof req.query.contactId === "string" && req.query.contactId) ||
    null;
  const { getSilo } = await import("../middleware/silo.js");
  const silo = getSilo(res);
  if (!contactId) {
    return res.status(200).json({ messages: [], total: 0 });
  }

  try {
    const result = await pool.query(
      `SELECT id, body, contact_id, direction, type, from_number, to_number, silo, cta_label, cta_action, created_at
       FROM communications_messages
       WHERE contact_id = $1
         AND silo = $2
         AND (type IS NULL OR type <> 'sms')
       ORDER BY created_at ASC
      `,
      [contactId, silo]
    );
    res.json({ messages: result.rows, total: result.rows.length });
  } catch {
    res.json({ messages: [], total: 0 });
  }
}));

// BF_SERVER_BLOCK_v763_MAYA_COMMS_SEPARATION - staff Maya tab. Lists Maya AI
// conversations that had a real back-and-forth (>= 2 messages) and serves one
// session's full transcript. Read-only; sourced from chat_sessions /
// chat_messages, independent of the Messages tab.
router.get("/maya-sessions", safeHandler(async (_req: any, res: any) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.source, s.channel, s.status, s.created_at,
              count(m.id)::int AS message_count,
              max(m.created_at) AS last_message_at,
              (SELECT COALESCE(message, content)
                 FROM chat_messages
                WHERE session_id = s.id
                ORDER BY created_at DESC LIMIT 1) AS last_message
         FROM chat_sessions s
         JOIN chat_messages m ON m.session_id = s.id
        GROUP BY s.id
       HAVING count(m.id) >= 2
        ORDER BY max(m.created_at) DESC
        LIMIT 200`,
    );
    res.json({ sessions: rows, total: rows.length });
  } catch {
    res.json({ sessions: [], total: 0 });
  }
}));

router.get("/maya-sessions/:id/messages", safeHandler(async (req: any, res: any) => {
  const sessionId = String(req.params.id ?? "");
  if (!sessionId) return res.status(400).json({ error: "missing_session_id" });
  try {
    const { rows } = await pool.query(
      `SELECT id, role, COALESCE(message, content) AS message, created_at
         FROM chat_messages
        WHERE session_id = $1
        ORDER BY created_at ASC`,
      [sessionId],
    );
    res.json({ messages: rows, total: rows.length });
  } catch {
    res.json({ messages: [], total: 0 });
  }
}));

// BF_SERVER_BLOCK_83_SMS_MESSAGES_TYPE_FILTER_v1 - SMS tab list must
// only show Twilio SMS threads. Inner LATERAL preview query also
// scoped to type='sms' so the snippet shown in the list matches what
// the thread view will load.
router.get("/sms", safeHandler(async (req: any, res: any) => {
  const { getSilo } = await import("../middleware/silo.js");
  const silo = getSilo(res);
  const mode = String(req.query.mode ?? "").toLowerCase();
  const threadsSql = `
    WITH base AS (
       SELECT
         COALESCE(m.contact_id::text, m.from_number) AS thread_key,
         m.contact_id,
         COALESCE(c.name, m.from_number, m.to_number) AS display_name,
         COALESCE(c.phone, m.from_number, m.to_number) AS phone,
         m.created_at,
         m.body,
         m.read_at,
         m.direction
       FROM communications_messages m
       LEFT JOIN contacts c ON c.id = m.contact_id
       WHERE m.silo = $1
         AND m.type = 'sms'
     ),
     ranked AS (
       SELECT
         *,
         ROW_NUMBER() OVER (PARTITION BY thread_key ORDER BY created_at DESC) AS rn,
         SUM(CASE WHEN read_at IS NULL AND direction = 'inbound' THEN 1 ELSE 0 END)
           OVER (PARTITION BY thread_key) AS unread_count
       FROM base
     )
     SELECT
       thread_key,
       contact_id,
       display_name,
       phone,
       created_at AS last_at,
       body AS last_body,
       unread_count
     FROM ranked
     WHERE rn = 1
  `;

  if (mode === "all") {
    const result = await pool.query(
      `WITH threads AS (${threadsSql})
       SELECT
         COALESCE(t.thread_key, ct.id::text) AS thread_key,
         COALESCE(t.contact_id, ct.id)       AS contact_id,
         COALESCE(t.display_name, ct.name, ct.email, ct.phone, 'Unknown') AS display_name,
         COALESCE(t.phone, ct.phone)         AS phone,
         t.last_at,
         t.last_body,
         COALESCE(t.unread_count, 0)         AS unread_count
       FROM contacts ct
       LEFT JOIN threads t ON t.contact_id = ct.id
       WHERE COALESCE(ct.status, 'active') <> 'archived'
         AND (ct.silo IS NULL OR ct.silo = $1)
       UNION ALL
       SELECT
         t.thread_key,
         t.contact_id,
         t.display_name,
         t.phone,
         t.last_at,
         t.last_body,
         COALESCE(t.unread_count, 0)
       FROM threads t
       WHERE t.contact_id IS NULL
       ORDER BY last_at DESC NULLS LAST, display_name ASC
       LIMIT 1000`,
      [silo],
    );
    return res.json({ conversations: result.rows });
  }

  const result = await pool.query(
    `${threadsSql}
     ORDER BY last_at DESC
     LIMIT 200`,
    [silo],
  );
  res.json({ conversations: result.rows });
}));



// BF_SERVER_BLOCK_101_MESSAGES_LIST_NON_SMS_v1 - in-portal Messages tab
// needs a list endpoint analogous to /sms but scoped to non-SMS rows.
// Threads are grouped by contact_id when present, otherwise application_id
// so application-linked handoff messages (without a contact yet) still show.
// BF_SERVER_BLOCK_v636_MESSAGES_TAB_FIXES_v1
// BF_SERVER_BLOCK_v637_MOBILE_PHONE_AND_BACKFILL_v1 - siloMiddleware runs BEFORE
// requireAuth so getSilo(res) always returned "BF" on authed routes (see comment
// at the bottom of silo.ts). Use resolveSiloFromRequest(req) which reads X-Silo
// + req.user together - otherwise BI-silo staff see BF threads.
router.get("/messages-list", safeHandler(async (req: any, res: any) => {
  const { resolveSiloFromRequest } = await import("../middleware/silo.js");
  const silo = resolveSiloFromRequest(req);
  const mode = String(req.query.mode ?? "").toLowerCase();
  const typesParam = String(req.query.types ?? "").trim();
  const types = typesParam ? typesParam.split(",").map((s) => s.trim()).filter(Boolean) : [];

  // v636: honor ?types=. Empty = original (any non-SMS).
  const typeClause = types.length
    ? `AND m.type = ANY($2::text[])`
    : `AND (m.type IS NULL OR m.type <> 'sms')`;
  const typeParams: any[] = types.length ? [silo, types] : [silo];

  const threadsSql = `
    WITH base AS (
      SELECT
        COALESCE(m.contact_id::text, m.application_id::text) AS thread_key,
        m.contact_id AS contact_id,
        COALESCE(c.name, c.email, c.phone, m.to_number, m.from_number, m.application_id::text) AS display_name,
        COALESCE(c.phone, m.from_number, m.to_number) AS phone,
        c.email AS email,
        m.created_at,
        m.body,
        m.read_at,
        m.direction
      FROM communications_messages m
      LEFT JOIN contacts c ON c.id = m.contact_id
      WHERE m.silo = $1
        -- BF_SERVER_MESSAGES_LIST_DROP_ORPHANS_v1: a deleted CRM contact sets
        -- communications_messages.contact_id to NULL (ON DELETE SET NULL). Inbound now
        -- always creates a contact, so a NULL contact_id here means the contact was
        -- deleted; drop those threads so they stop showing as "Unknown contact".
        AND m.contact_id IS NOT NULL
        ${typeClause}
    ),
    -- BF_SERVER_MESSAGES_LIST_PERF_v1: DISTINCT ON walks the (silo, contact_id, created_at DESC)
    -- index and stops at the first row per thread, instead of ranking every message in the silo
    -- with two window functions. Unread is a separate aggregate over the partial index.
    latest AS (
      SELECT DISTINCT ON (thread_key)
        thread_key, contact_id, display_name, phone, email, created_at, body
      FROM base
      ORDER BY thread_key, created_at DESC
    ),
    unread AS (
      SELECT thread_key, COUNT(*)::int AS unread_count
      FROM base
      WHERE read_at IS NULL AND direction = 'inbound'
      GROUP BY thread_key
    )
    SELECT
      l.thread_key,
      l.contact_id,
      l.display_name,
      l.phone,
      l.email,
      l.created_at AS last_at,
      l.body AS last_body,
      COALESCE(u.unread_count, 0) AS unread_count
    FROM latest l
    LEFT JOIN unread u ON u.thread_key = l.thread_key
  `;

  if (mode === "all") {
    // v636: include every silo contact, even with no prior message rows.
    const result = await pool.query(
      `WITH threads AS (${threadsSql})
       SELECT
         COALESCE(t.thread_key, ct.id::text) AS thread_key,
         COALESCE(t.contact_id, ct.id)       AS contact_id,
         COALESCE(t.display_name, ct.name, ct.email, ct.phone, 'Unknown') AS display_name,
         COALESCE(t.phone, ct.phone)         AS phone,
         COALESCE(t.email, ct.email)         AS email,
         t.last_at,
         t.last_body,
         COALESCE(t.unread_count, 0)         AS unread_count
       FROM contacts ct
       LEFT JOIN threads t ON t.contact_id = ct.id
       WHERE COALESCE(ct.status, 'active') <> 'archived'
         AND (ct.silo IS NULL OR ct.silo = $1)
       UNION ALL
       SELECT t.thread_key, t.contact_id, t.display_name, t.phone, t.email,
              t.last_at, t.last_body, COALESCE(t.unread_count, 0)
         FROM threads t
        WHERE t.contact_id IS NULL
       ORDER BY last_at DESC NULLS LAST, display_name ASC
       LIMIT 1000`,
      typeParams,
    );
    return res.json({ conversations: result.rows });
  }

  // Default: only rows with messages (original v220 behaviour, now type-filterable).
  const result = await pool.query(
    `${threadsSql} ORDER BY last_at DESC LIMIT 200`,
    typeParams,
  );
  res.json({ conversations: result.rows });
}));

// BF_SERVER_BLOCK_83_SMS_MESSAGES_TYPE_FILTER_v1 - thread loader scoped to type='sms'.
router.get("/sms/thread", safeHandler(async (req: any, res: any) => {
  const { getSilo } = await import("../middleware/silo.js");
  const silo = String(getSilo(res) ?? req.user?.silo ?? "BF").toUpperCase();
  const rawContact = req.query.contactId ? String(req.query.contactId) : "";
  const rawPhone = req.query.phone ? String(req.query.phone) : "";

  let phone: string | null = null;
  let contactId: string | null = null;

  if (/^new-\d+$/.test(rawContact)) {
    phone = rawContact.slice(4);
  } else if (/^[0-9a-f-]{36}$/i.test(rawContact)) {
    contactId = rawContact;
  } else if (rawPhone) {
    phone = rawPhone;
  } else if (rawContact && /^[+0-9]+$/.test(rawContact)) {
    phone = rawContact;
  }

  if (!contactId && !phone) {
    return res.status(200).json({ messages: [] });
  }

  const params: unknown[] = [silo];
  let where = "silo = $1";
  if (contactId) {
    // v635_orphan_sms: match contact_id directly OR (contact_id IS NULL AND
    // from_number/to_number digit-suffix matches the contact's phone).
    // Covers inbound SMS persisted before Z9 normalize when contact lookup
    // missed due to phone format mismatch.
    params.push(contactId);
    const cIdx = params.length;
    where += ` AND (
      contact_id = $${cIdx}
      OR (contact_id IS NULL AND EXISTS (
        -- BF_SERVER_BLOCK_v637_MOBILE_PHONE_AND_BACKFILL_v1: contacts.mobile_phone
        -- column does not exist (see migrations/099_create_contacts_table.sql).
        -- This query threw on every authed SMS thread fetch - "sms_thread_error"
        -- in BF-Server logs every 5s. Only c.phone is real.
        SELECT 1 FROM contacts c
         WHERE c.id = $${cIdx}
           AND (
             right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10)
               = right(regexp_replace(coalesce(communications_messages.from_number, ''), '[^0-9]', '', 'g'), 10)
             OR right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10)
               = right(regexp_replace(coalesce(communications_messages.to_number,   ''), '[^0-9]', '', 'g'), 10)
           )
      ))
    )`;
  } else if (phone) {
    const compact = phone.replace(/[^\d]/g, "");
    const e164 = phone.startsWith("+") ? phone : `+${compact}`;
    params.push(phone, e164, compact);
    where += ` AND contact_id IS NULL AND (
      from_number IN ($${params.length - 2}, $${params.length - 1}, $${params.length}) OR
      to_number   IN ($${params.length - 2}, $${params.length - 1}, $${params.length})
    )`;
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, contact_id, from_number, to_number, direction, body,
              media_url, created_at, read_at
       FROM communications_messages
       WHERE ${where}
         AND type = 'sms'
       ORDER BY created_at ASC
       LIMIT 500`,
      params,
    );
    return res.status(200).json({ messages: rows });
  } catch (err) {
    console.error({ event: "sms_thread_error", err: String(err) });
    return res.status(200).json({ messages: [] });
  }
}));

// BF_SERVER_SMS_MEDIA_v1 - stream an inbound MMS image/file. Twilio media URLs
// require Basic auth, so the browser can't <img> them directly; proxy with the
// account creds. Token rides the query string so it works in an <img src>.
router.get("/messages/:id/media", safeHandler(async (req: any, res: any) => {
  const token = String(req.query?.token ?? "");
  try { verifyAccessToken(token); } catch { return res.status(401).end(); }
  const id = String(req.params?.id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).end();
  const { rows } = await pool.query<{ media_url: string | null }>(
    "SELECT media_url FROM communications_messages WHERE id = $1::uuid LIMIT 1",
    [id],
  );
  const mediaUrl = rows[0]?.media_url ?? null;
  if (!mediaUrl) return res.status(404).end();
  // BF_SERVER_MMS_BLOB_PROXY_v1 - render inbound MMS reliably. Already-persisted
  // (public blob / non-Twilio) URLs stream directly. A raw Twilio URL is copied
  // to public blob on first view (self-heal) so it never breaks again when Twilio
  // purges the media, then streamed from the bytes we just downloaded. The fetch
  // follows Twilio's S3 redirect WITHOUT leaking the auth header.
  let buf: Buffer;
  let ct = "application/octet-stream";
  if (/api\.twilio\.com/.test(mediaUrl)) {
    const persisted = await persistTwilioMediaToBlob(mediaUrl);
    if (persisted) {
      await pool
        .query("UPDATE communications_messages SET media_url = $2 WHERE id = $1::uuid", [id, persisted.url])
        .catch(() => {});
      ct = persisted.contentType || ct;
      buf = persisted.buffer;
    } else {
      const direct = await fetchTwilioMedia(mediaUrl);
      if (!direct) return res.status(502).end();
      ct = direct.contentType || ct;
      buf = direct.buffer;
    }
  } else {
    try {
      const upstream = await fetch(mediaUrl);
      if (!upstream.ok) return res.status(502).end();
      ct = upstream.headers.get("content-type") ?? ct;
      buf = Buffer.from(await upstream.arrayBuffer());
    } catch {
      return res.status(502).end();
    }
  }
  res.setHeader("Content-Type", ct);
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  return res.status(200).end(buf);
}));

// BF_SERVER_RECORDING_PROXY_v1 - stream a call recording for the contact-card
// <audio> player. Twilio Recording URLs require Basic auth (browser stalls at
// 0:00), so proxy by conference id and self-heal raw Twilio URLs into public
// blob so playback survives Twilio media purge.
router.get("/recordings/by-conference/:conferenceId/media", safeHandler(async (req: any, res: any) => {
  const token = String(req.query?.token ?? "");
  try { verifyAccessToken(token); } catch { return res.status(401).end(); }
  const cid = String(req.params?.conferenceId ?? "");
  if (!/^[0-9a-fA-F-]{8,40}$/.test(cid)) return res.status(400).end();
  const { rows } = await pool.query<{ id: string; url: string | null }>(
    "SELECT id::text AS id, url FROM call_recordings WHERE conference_id = $1 AND url IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    [cid],
  );
  const recUrl = rows[0]?.url ?? null;
  if (!recUrl) return res.status(404).end();
  let buf: Buffer;
  let ct = "audio/mpeg";
  if (/api\.twilio\.com/.test(recUrl)) {
    const persisted = await persistTwilioMediaToBlob(recUrl);
    if (persisted) {
      const recId = rows[0]?.id;
      if (recId) {
        await pool.query("UPDATE call_recordings SET url = $2 WHERE id = $1::uuid", [recId, persisted.url]).catch(() => {});
      }
      await pool.query("UPDATE conferences SET recording_url = $2 WHERE id = $1", [cid, persisted.url]).catch(() => {});
      ct = persisted.contentType || ct;
      buf = persisted.buffer;
    } else {
      const direct = await fetchTwilioMedia(recUrl);
      if (!direct) return res.status(502).end();
      ct = direct.contentType || ct;
      buf = direct.buffer;
    }
  } else {
    try {
      const upstream = await fetch(recUrl);
      if (!upstream.ok) return res.status(502).end();
      ct = upstream.headers.get("content-type") ?? ct;
      buf = Buffer.from(await upstream.arrayBuffer());
    } catch {
      return res.status(502).end();
    }
  }
  res.setHeader("Content-Type", ct);
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  return res.status(200).end(buf);
}));

// BF_SERVER_BLOCK_BI_ROUND6_THREADS_LIST_v1
// GET /api/communications/threads
// Returns the live communications conversations scoped to the caller's
// silo (via Block 13's resolveSiloFromRequest fix -- after that block,
// res.locals.silo carries the correct silo on every authed route). Used
// by the staff Communications page to populate the thread list.
//
// Response shape matches the portal's CommunicationConversation
// type declared in BF-portal src/api/communications.ts:
//   id, sessionId, type, status, silo, contactId, contactName,
//   contactEmail, contactPhone, assignedTo, message (last preview),
//   updatedAt, messages: []
//
// `messages: []` is returned empty here; the portal fetches the
// full message list lazily per session via subscribeAiSocket
// after Block 19 lands. Adding a `messages` join would 10x the
// row size for what's typically a list view that only displays
// the preview.
router.get("/threads", safeHandler(async (req: any, res: any) => {
  const { resolveSiloFromRequest } = await import("../middleware/silo.js");
  const silo = resolveSiloFromRequest(req);

  // The "businessUnit" query param is what the portal sends; it's
  // identical in intent to the X-Silo header but explicit for the
  // cases where the staff page wants to look at a different silo
  // (admin tooling). Treat it as an override only if the user is
  // admin -- the resolver already enforces allowlist for non-admins.
  const requestedBu = typeof req.query.businessUnit === "string"
    ? req.query.businessUnit.toUpperCase()
    : null;
  const isAdmin = String(req.user?.role ?? "").toLowerCase() === "admin";
  const effectiveSilo = isAdmin && requestedBu && /^(BF|BI|SLF)$/.test(requestedBu)
    ? requestedBu
    : silo;

  // BF_SERVER_BLOCK_v685_THREADS_ON_COMMUNICATIONS_v1
  // The live conversation store is communications_conversations /
  // communications_messages (chat_sessions/chat_messages are dead).
  // Read the real store so messenger handoffs + SMS surface in the
  // portal Messages tab. has_outbound flags threads a human replied to.
  const sql = `
    SELECT
      cc.id,
      cc.id AS session_id,
      cc.channel,
      cc.contact_id AS crm_contact_id,
      cc.contact_name,
      COALESCE(ct.phone, cc.contact_phone) AS contact_phone,
      cc.last_message_preview AS last_message,
      cc.unread,
      cc.silo AS contact_silo,
      cc.last_message_at,
      cc.created_at,
      cc.updated_at,
      EXISTS (
        SELECT 1 FROM communications_messages m
        WHERE m.conversation_id = cc.id AND m.direction = 'outbound'
      ) AS has_outbound,
      ct.name AS contact_full_name,
      ct.email AS contact_email
    FROM communications_conversations cc
    LEFT JOIN contacts ct ON ct.id = cc.contact_id
    WHERE cc.silo = $1
    ORDER BY cc.last_message_at DESC NULLS LAST, cc.created_at DESC
    LIMIT 200
  `;

  const result = await pool.query(sql, [effectiveSilo]).catch((err: any) => {
    // eslint-disable-next-line no-console
    console.warn("communications.threads.query_failed", {
      silo: effectiveSilo,
      message: err?.message,
      code: err?.code,
    });
    return { rows: [] as any[] };
  });

  const conversations = result.rows.map((row: any) => {
    const channel = String(row.channel ?? "").toLowerCase();
    // sms keeps its own tab/type; everything else (messenger, chat,
    // contact_form) maps to a chat/human thread so it shows in the
    // portal's Active list (filter accepts human|chat|credit_readiness).
    const type = channel === "sms" ? "sms" : (row.has_outbound ? "human" : "chat");
    return {
      id: row.id,
      sessionId: row.session_id,
      type,
      status: "human" as const,
      silo: row.contact_silo ?? effectiveSilo,
      contactId: row.crm_contact_id ?? undefined,
      contactName: row.contact_full_name ?? row.contact_name ?? undefined,
      contactEmail: row.contact_email ?? undefined,
      contactPhone: row.contact_phone ?? undefined,
      unread: typeof row.unread === "number" ? row.unread : undefined,
      message: row.last_message ?? undefined,
      messages: [] as unknown[],
      updatedAt: row.last_message_at ?? row.updated_at ?? row.created_at,
    };
  });

  return res.status(200).json(conversations);
}));

// BF_SERVER_BLOCK_BI_ROUND6_THREADS_DETAIL_v1
// GET /api/communications/threads/:id
// Returns a single communications conversation payload with the full
// messages array. Staff panel calls this when activeSessionId changes
// so the message area populates with history. The list endpoint
// (Block 20) deliberately returns messages: [] for performance
// and defers message loading to this endpoint.
//
// Silo gate: contact_silo on the conversation must match the caller's
// resolved silo, unless the caller is an admin. Returns 404 (not 403)
// when no row exists so we don't leak which thread ids are valid in
// other silos.
router.get("/threads/:id", safeHandler(async (req: any, res: any) => {
  const { resolveSiloFromRequest } = await import("../middleware/silo.js");
  const silo = resolveSiloFromRequest(req);
  const sessionId = String(req.params.id ?? "").trim();
  if (!sessionId) return res.status(400).json({ error: "missing_session_id" });

  const isAdmin = String(req.user?.role ?? "").toLowerCase() === "admin";

  // BF_SERVER_BLOCK_v685_THREADS_ON_COMMUNICATIONS_v1 - detail reads
  // the live communications_conversations store (dead chat_sessions
  // retired). contact_silo is the conversation's own silo column.
  const sessionResult = await pool.query(`
    SELECT
      cc.id,
      cc.id AS session_id,
      cc.channel,
      cc.contact_id AS crm_contact_id,
      cc.contact_name,
      COALESCE(ct.phone, cc.contact_phone) AS contact_phone,
      cc.silo AS contact_silo,
      cc.created_at,
      cc.updated_at,
      cc.last_message_at,
      ct.name AS contact_full_name,
      ct.email AS contact_email
    FROM communications_conversations cc
    LEFT JOIN contacts ct ON ct.id = cc.contact_id
    WHERE cc.id = $1
    LIMIT 1
  `, [sessionId]).catch((err: any) => {
    // eslint-disable-next-line no-console
    console.warn("communications.threads.detail.session_query_failed", {
      sessionId, message: err?.message, code: err?.code,
    });
    return { rows: [] as any[] };
  });

  const session = sessionResult.rows[0];
  if (!session) return res.status(404).json({ error: "session_not_found" });

  // Silo gate. Anonymous sessions (contact_silo null) pass.
  if (!isAdmin && session.contact_silo && session.contact_silo !== silo) {
    return res.status(404).json({ error: "session_not_found" });
  }

  // Load messages. 500-row cap protects against unbounded message
  // history rendering in the portal; if a real session ever exceeds
  // this we add pagination cursors in a follow-up.
  const messagesResult = await pool.query(`
    SELECT id, conversation_id, channel, direction, body, type, media_url, media_duration_seconds, created_at
    FROM communications_messages
    WHERE conversation_id = $1
    ORDER BY created_at ASC
    LIMIT 500
  `, [sessionId]).catch((err: any) => {
    // eslint-disable-next-line no-console
    console.warn("communications.threads.detail.messages_query_failed", {
      sessionId, message: err?.message, code: err?.code,
    });
    return { rows: [] as any[] };
  });

  const messages = messagesResult.rows.map((m: any) => {
    const dir = String(m.direction ?? "").toLowerCase();
    const direction = dir === "inbound" ? "in" : dir === "outbound" ? "out" : "system";
    const ch = String(m.channel ?? session.channel ?? "").toLowerCase();
    return {
      id: m.id,
      conversationId: sessionId,
      type: m.type === "voicemail" ? "voicemail" : ch === "sms" ? "sms" : "chat",
      direction,
      message: m.body ?? "",
      mediaUrl: m.media_url ?? undefined,
      mediaDurationSeconds: m.media_duration_seconds ?? undefined,
      createdAt: m.created_at,
    };
  });

  const channel = String(session.channel ?? "").toLowerCase();
  const hasOutbound = messages.some((m: any) => m.direction === "out");
  const type = channel === "sms" ? "sms" : (hasOutbound ? "human" : "chat");
  const status = "human";

  return res.status(200).json({
    id: session.id,
    sessionId: session.session_id,
    type,
    status,
    silo: session.contact_silo ?? silo,
    contactId: session.crm_contact_id ?? undefined,
    contactName: session.contact_full_name ?? session.contact_name ?? undefined,
    contactEmail: session.contact_email ?? undefined,
    contactPhone: session.contact_phone ?? undefined,
    message: messages.length ? messages[messages.length - 1].message : undefined,
    messages,
    updatedAt: session.last_message_at ?? session.updated_at ?? session.created_at,
  });
}));

// BF_SERVER_BLOCK_v685_THREADS_REPLY_v1
// POST /api/communications/threads/:id/messages - staff reply.
// The portal (sendCommunication) posts here; previously no such
// route existed, so Send 404'd. Writes an outbound row into
// communications_messages and bumps the conversation preview, then
// returns the CommunicationMessage shape the portal expects.
router.post(
  "/threads/:id/messages",
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any) => {
    const conversationId = String(req.params.id ?? "").trim();
    if (!conversationId) return res.status(400).json({ error: "missing_conversation_id" });
    const body = String(req.body?.body ?? req.body?.message ?? "").trim();
    if (!body) return res.status(400).json({ error: "missing_body" });

    const convo = await pool.query(
      `SELECT id, channel, silo FROM communications_conversations WHERE id = $1 LIMIT 1`,
      [conversationId],
    );
    if (!convo.rows[0]) return res.status(404).json({ error: "conversation_not_found" });
    const channel = String(req.body?.channel ?? convo.rows[0].channel ?? "messenger").toLowerCase();

    const inserted = await pool.query(
      `INSERT INTO communications_messages (id, conversation_id, channel, direction, body, silo, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'outbound', $3, $4, NOW())
       RETURNING id, conversation_id, channel, direction, body, created_at`,
      [conversationId, channel, body, convo.rows[0].silo],
    );

    await pool.query(
      `UPDATE communications_conversations
         SET last_message_preview = $2, last_message_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [conversationId, body.slice(0, 280)],
    ).catch(() => undefined);

    const row = inserted.rows[0];
    return res.status(201).json({
      id: row.id,
      conversationId: row.conversation_id,
      type: channel === "sms" ? "sms" : "chat",
      direction: "out",
      message: row.body ?? "",
      createdAt: row.created_at,
    });
  }),
);

// BF_SERVER_BLOCK_BI_ROUND5_D_TIMELINE_v1
// GET /api/communications/timeline?phone=<E.164>&limit=<n>
// Returns calls + SMS events for a phone number scoped to the
// caller's silo (X-Silo header / ?silo / allowlist enforced by
// resolveSiloFromRequest). Built to back the BI silo contact
// detail timeline (Block 11) but useful anywhere BF-portal wants
// a unified feed without two round-trips.
//
// Phone matching tolerates raw vs compact-digits variants -- the
// same trick GET /sms already uses, so a contact stored as
// "+15878881837" and a call log with phone_number "15878881837"
// still match.
//
// Response shape:
//   {
//     events: Array<{
//       id: string,
//       kind: "call" | "sms",
//       direction: "inbound" | "outbound" | null,
//       status: string | null,
//       body: string | null,             // SMS body (null for call)
//       duration_seconds: number | null, // call only
//       from_number: string | null,
//       to_number: string | null,
//       silo: string,
//       application_id: string | null,
//       twilio_sid: string | null,
//       staff_name: string | null,       // SMS persisted with name
//       staff_user_id: string | null,    // call persisted with id
//       created_at: string,              // ISO
//     }>,
//     total: number,
//     silo: string
//   }
router.get("/timeline", safeHandler(async (req: any, res: any) => {
  const phone = String(req.query.phone ?? "").trim();
  if (!phone) {
    return res.status(400).json({ error: { message: "phone is required (E.164)", code: "validation_error" } });
  }
  const compact = phone.replace(/[^\d]/g, "");
  const e164 = phone.startsWith("+") ? phone : (compact ? `+${compact}` : phone);
  const phoneVariants = Array.from(new Set([phone, e164, compact].filter(Boolean)));

  const { resolveSiloFromRequest } = await import("../middleware/silo.js");
  const silo = resolveSiloFromRequest(req);

  const limit = Math.min(Number(req.query.limit ?? 200) || 200, 500);

  // call_logs: outbound to_number == phone, inbound from_number == phone,
  // or the older callers that stored everything in phone_number.
  const callsRes = await pool.query(
    `SELECT id, twilio_call_sid AS twilio_sid, direction, status,
            duration_seconds, from_number, to_number, staff_user_id,
            application_id, silo, created_at
       FROM call_logs
      WHERE silo = $1
        AND (phone_number = ANY($2::text[])
          OR from_number  = ANY($2::text[])
          OR to_number    = ANY($2::text[]))
      ORDER BY created_at DESC
      LIMIT $3`,
    [silo, phoneVariants, limit],
  ).catch((err: any) => {
    // eslint-disable-next-line no-console
    console.warn("communications.timeline.calls_query_failed", {
      silo, phone, message: err?.message, code: err?.code,
    });
    return { rows: [] as any[] };
  });

  const smsRes = await pool.query(
    `SELECT id, twilio_sid, direction, status, body, from_number,
            to_number, staff_name, application_id, silo, created_at
       FROM communications_messages
      WHERE silo = $1
        AND (phone_number = ANY($2::text[])
          OR from_number  = ANY($2::text[])
          OR to_number    = ANY($2::text[]))
      ORDER BY created_at DESC
      LIMIT $3`,
    [silo, phoneVariants, limit],
  ).catch((err: any) => {
    // eslint-disable-next-line no-console
    console.warn("communications.timeline.sms_query_failed", {
      silo, phone, message: err?.message, code: err?.code,
    });
    return { rows: [] as any[] };
  });

  // BF_SERVER_BLOCK_v851 - surface call recordings + transcripts on the
  // phone-keyed timeline (the BI contact card reads this), so BI shows the same
  // recording/transcript history BF does.
  const recRes = await pool.query(
    `SELECT cr.id, cr.url, cr.duration_sec, cr.created_at,
            ct.full_text, ct.voice_intelligence_summary
       FROM call_recordings cr
       JOIN conferences c ON c.id = cr.conference_id
       JOIN conference_participants cp ON cp.conference_id = c.id
       LEFT JOIN call_transcripts ct ON ct.conference_id = cr.conference_id
      WHERE c.silo = $1
        AND cp.phone_number = ANY($2::text[])
      ORDER BY cr.created_at DESC
      LIMIT $3`,
    [silo, phoneVariants, limit],
  ).catch((err: any) => {
    console.warn("communications.timeline.recordings_query_failed", { silo, phone, message: err?.message, code: err?.code });
    return { rows: [] as any[] };
  });

  const events = [
    ...recRes.rows.map((r: any) => ({
      id: r.id,
      kind: "recording" as const,
      direction: null,
      status: null,
      body: r.voice_intelligence_summary ?? r.full_text ?? null,
      duration_seconds: r.duration_sec ?? null,
      from_number: null,
      to_number: null,
      silo,
      application_id: null,
      twilio_sid: null,
      staff_name: null,
      staff_user_id: null,
      recording_url: r.url ?? null,
      created_at: r.created_at,
    })),
    ...callsRes.rows.map((r: any) => ({
      id: r.id,
      kind: "call" as const,
      direction: r.direction ?? null,
      status: r.status ?? null,
      body: null,
      duration_seconds: r.duration_seconds ?? null,
      from_number: r.from_number ?? null,
      to_number: r.to_number ?? null,
      silo: r.silo ?? silo,
      application_id: r.application_id ?? null,
      twilio_sid: r.twilio_sid ?? null,
      staff_name: null,
      staff_user_id: r.staff_user_id ?? null,
      created_at: r.created_at,
    })),
    ...smsRes.rows.map((r: any) => ({
      id: r.id,
      kind: "sms" as const,
      direction: r.direction ?? null,
      status: r.status ?? null,
      body: r.body ?? null,
      duration_seconds: null,
      from_number: r.from_number ?? null,
      to_number: r.to_number ?? null,
      silo: r.silo ?? silo,
      application_id: r.application_id ?? null,
      twilio_sid: r.twilio_sid ?? null,
      staff_name: r.staff_name ?? null,
      staff_user_id: null,
      created_at: r.created_at,
    })),
  ]
    .sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return tb - ta;
    })
    .slice(0, limit);

  return res.status(200).json({ events, total: events.length, silo });
}));

// POST /api/communications/sms - send outbound + persist to DB
router.post("/sms", safeHandler(async (req: any, res: any) => {
  const { contactId, to, body } = req.body ?? {};
  let applicationId = req.body?.applicationId ?? null;
  if (!body || !to) {
    return res.status(400).json({ error: { message: "to and body are required", code: "validation_error" } });
  }
  // BF_SERVER_BLOCK_53_v1 -- if staff didn't pass applicationId,
  // resolve it from contactId. Otherwise the row has NULL app_id
  // and the mini-portal client poll never sees it. Pick the most
  // recently updated application owned by that contact.
  if (!applicationId && contactId) {
    try {
      const lookup = await pool.query<{ id: string }>(
        `SELECT id FROM applications
         WHERE contact_id = $1
         ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
         LIMIT 1`,
        [contactId]
      );
      if (lookup.rows[0]?.id) applicationId = lookup.rows[0].id;
    } catch { /* leave applicationId null */ }
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  // BF_SERVER_BLOCK_v325_COMMS_SMS_FROM_ENV_FALLBACK_v1
  // Pre-fix this read `TWILIO_FROM_NUMBER ?? TWILIO_PHONE_NUMBER` only.
  // TWILIO_FROM_NUMBER is NOT a recognized env var anywhere in
  // src/config/schema.ts (the schema validates TWILIO_PHONE, TWILIO_FROM,
  // TWILIO_NUMBER, TWILIO_PHONE_NUMBER), and the sibling SMS sender at
  // src/modules/notifications/sms.service.ts:15 uses
  //   config.twilio.from || config.twilio.number || config.twilio.phone
  // -- a totally different fallback chain. The two endpoints don't agree
  // on which env var supplies the FROM number.
  // Result: if the operator set their Twilio number under TWILIO_FROM,
  // TWILIO_PHONE, or TWILIO_NUMBER (the names commonly used in Twilio
  // docs and the only ones the config schema actually validates), this
  // endpoint 503'd with "SMS not configured". Outbound staff SMS via the
  // Communications page broke even though OTP SMS (which uses different
  // code) worked fine -- a confusing partial-failure mode.
  // Fix: accept all four naming conventions. Order: TWILIO_FROM_NUMBER
  // (legacy custom) -> TWILIO_PHONE_NUMBER -> TWILIO_FROM -> TWILIO_PHONE
  // -> TWILIO_NUMBER. Matches sms.service.ts's intent (cover both prefixed
  // and unprefixed) while preserving any legacy deployments that may
  // have used the original two names.
  const from = process.env.TWILIO_FROM_NUMBER
    ?? process.env.TWILIO_PHONE_NUMBER
    ?? process.env.TWILIO_FROM
    ?? process.env.TWILIO_PHONE
    ?? process.env.TWILIO_NUMBER;
  if (!accountSid || !authToken || !from) {
    return res.status(503).json({ error: { message: "SMS not configured", code: "service_unavailable" } });
  }
  const client: any = twilio(accountSid, authToken);
  // BF_SERVER_COMMS_SMS_TWILIO_ERROR_v1 - wrap the Twilio send so a rejection
  // (invalid number, A2P/10DLC, geo-permission, funds) returns the real code
  // instead of an opaque 500. Without this every Twilio failure looked
  // identical from the portal and was easy to mistake for a refresh bug.
  let message: any;
  let mergedBody: string = String(body);
  try {
    const __smsCtx = await mergeCtxForContact({ contactId, phone: to });
    mergedBody = renderMergeTokensComm(String(body), __smsCtx);
    message = await client.messages.create({ body: String(mergedBody), from, to: String(to) });
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error("communications.sms.twilio_failed", {
      to: String(to), from, code: err?.code, status: err?.status,
      message: err?.message, moreInfo: err?.moreInfo,
    });
    return res.status(502).json({
      error: {
        message: err?.message || "Failed to send SMS",
        code: err?.code ? `twilio_${err.code}` : "sms_send_failed",
        twilioCode: err?.code ?? null,
        moreInfo: err?.moreInfo ?? null,
      },
    });
  }

  // Persist outbound message to DB
  // BF_SERVER_BLOCK_v312_COMMS_SMS_PERSIST_LOG_v1
  // Pre-fix this used .catch(() => {}) - the Twilio send had already
  // succeeded (the user received the SMS) but the local persistence INSERT
  // would silently swallow on column drift / DB hiccup. On the next refresh
  // of the Communications thread, the outbound message would be absent
  // from the staff view (since /sms/thread reads from communications_messages),
  // making it look like the send didn't happen. Log the error so the next
  // schema drift is visible; still return success because the user-facing
  // SMS has already gone out and there is no way to unsend it.
  const staffName = (req as any).user?.name ?? (req as any).user?.email ?? null;
  // BF_SERVER_BLOCK_BI_ROUND5_B_v1 -- silo source moved from
  // req.user.silo (JWT-pinned primary silo) to
  // resolveSiloFromRequest(req) (X-Silo header / ?silo / allowlist).
  // Fixes the case where a multi-silo or admin user switching to
  // the BI silo in the topbar got their SMS persisted as silo='BF'
  // because the JWT primary silo never changes.
  const { resolveSiloFromRequest } = await import("../middleware/silo.js");
  const silo = resolveSiloFromRequest(req);
  const normalizedToDigits = String(to).replace(/\D/g, "");
  const normalizedTo = normalizedToDigits.length === 10 ? `+1${normalizedToDigits}` : String(to);
  let resolvedContactId: string | null = contactId ?? null;
  if (!resolvedContactId) {
    const canonicalContact = await pool.query<{ id: string }>(
      `SELECT id
         FROM contacts
        WHERE right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) =
              right(regexp_replace($1::text,           '[^0-9]', '', 'g'), 10)
        ORDER BY created_at ASC NULLS LAST, id ASC
        LIMIT 1`,
      [normalizedTo]
    ).then((r) => r.rows[0] ?? null).catch(() => null);
    resolvedContactId = canonicalContact?.id ?? null;
    if (!resolvedContactId) {
      console.warn("sms_outbound_no_contact_id", { to: normalizedTo });
    }
  }
  await pool.query(
    `INSERT INTO communications_messages
       (id, type, direction, status, body, phone_number, from_number, to_number,
        twilio_sid, contact_id, application_id, staff_name, silo, created_at)
     VALUES (gen_random_uuid(), 'sms', 'outbound', $1, $2, $3, $4, $3, $5, $6, $7, $8, $9, now())`,
    [
      message.status,
      String(mergedBody),
      String(to),
      from,
      message.sid,
      resolvedContactId,
      applicationId ?? null,
      staffName,
      silo,
    ]
  ).catch((err: any) => {
    // eslint-disable-next-line no-console
    console.warn("communications.sms.persist_failed", {
      twilioSid: message.sid,
      contactId: resolvedContactId,
      applicationId: applicationId ?? null,
      message: err?.message,
      code: err?.code,
    });
  });

  res.json({ id: message.sid, status: message.status, contactId: resolvedContactId });
}));

// BF_SERVER_BLOCK_43_v1 -- application-scoped message endpoints.
// Used by the BF-portal MessagesTab inside the application drawer
// and by any other staff flow that wants to push a message into
// a specific application's thread (alongside the SMS that
// sendDocumentRejectionSms already fires).

// BF_SERVER_BLOCK_v644_PORTAL_MESSAGES_CONTACT_v1 - contact-keyed thread
// fetch. Returns all type='message' rows across every application the
// contact has (one rolling conversation per contact, per Todd's #2).
// Either ?contactId=... or ?applicationId=... is accepted; contactId wins
// if both are sent.
router.get(
  "/messages/thread",
  safeHandler(async (req: any, res: any) => {
    const contactId = typeof req.query?.contactId === "string"
      ? String(req.query.contactId).trim()
      : "";
    const applicationId = typeof req.query?.applicationId === "string"
      ? String(req.query.applicationId).trim()
      : "";
    if (!contactId && !applicationId) {
      return res.status(400).json({
        error: { code: "validation_error", message: "contactId or applicationId required" },
      });
    }
    const result = await pool.query<{
      id: string;
      body: string | null;
      direction: string | null;
      staff_name: string | null;
      read_at: string | null;
      cta_label: string | null;
      cta_action: string | null;
      attachments: any;
      created_at: string;
    }>(
      `SELECT id, body, direction, staff_name, read_at,
              cta_label, cta_action, attachments, created_at
         FROM communications_messages
        WHERE type = 'message'
          AND (
            ($1 <> '' AND contact_id = NULLIF($1, '')::uuid)
            OR ($2 <> '' AND application_id = NULLIF($2, ''))
          )
        ORDER BY created_at ASC
        LIMIT 1000`,
      [contactId, applicationId],
    );
    res.json(
      (result.rows as any[]).map((r: any) => ({
        id: r.id,
        body: r.body ?? "",
        senderType: r.direction === "inbound" ? "client" : "staff",
        senderName: r.staff_name ?? null,
        source: r.direction === "inbound" ? "client" : "staff",
        createdAt: r.created_at,
        readAt: r.read_at,
        status: r.read_at ? "read" : "delivered",
        ctaLabel: r.cta_label,
        ctaAction: r.cta_action,
        // BF_SERVER_BLOCK_v646_COMPLETE_COMMS_v1
        attachments: Array.isArray(r.attachments) ? r.attachments : null,
      })),
    );
  }),
);

// GET /api/communications/messages/thread/:applicationId
router.get(
  "/messages/thread/:applicationId",
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.params.applicationId === "string"
      ? req.params.applicationId.trim()
      : "";
    if (!applicationId) {
      return res.status(400).json({
        error: { code: "validation_error", message: "applicationId required" },
      });
    }

    const result = await pool.query<{
      id: string;
      body: string | null;
      direction: string | null;
      staff_name: string | null;
      read_at: string | null;
      cta_label: string | null;
      cta_action: string | null;
      created_at: string;
    }>(
      `SELECT id, body, direction, staff_name, read_at,
              cta_label, cta_action, created_at
         FROM communications_messages
        WHERE application_id = $1
        ORDER BY created_at ASC
        LIMIT 500`,
      [applicationId],
    );

    // BF-portal MessagesTab consumes MessageRecord[] directly (top-level
    // array), not { items: [...] }. Match that shape.
    res.json(
      result.rows.map((r) => ({
        id: r.id,
        body: r.body ?? "",
        senderType: r.direction === "inbound" ? "client" : "staff",
        senderName: r.staff_name ?? null,
        source: r.direction === "inbound" ? "client" : "staff",
        createdAt: r.created_at,
        readAt: r.read_at,
        status: r.read_at ? "read" : "delivered",
        ctaLabel: r.cta_label,
        ctaAction: r.cta_action,
      })),
    );
  }),
);

// POST /api/communications/messages/send
// Persists an outbound staff message into the application thread.
// Optional cta_label + cta_action surface a button on the client's
// chat bubble. Does NOT auto-send SMS -- staff use /communications/sms
// when they want a phone-channel side effect.
router.post(
  // BF_SERVER_BLOCK_v644_PORTAL_MESSAGES_CONTACT_v1 - accept contactId so
  // the staff Messages tab can address a contact directly without needing
  // an applicationId. Threads are contact-keyed. Offline-fallback SMS
  // uses contact.phone directly when no application is in play.
  "/messages/send",
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.body?.applicationId === "string"
      ? req.body.applicationId.trim()
      : "";
    const contactId = typeof req.body?.contactId === "string"
      ? req.body.contactId.trim()
      : "";
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    const ctaLabel  = typeof req.body?.ctaLabel  === "string" ? req.body.ctaLabel.trim().slice(0, 80)  : null;
    const ctaAction = typeof req.body?.ctaAction === "string" ? req.body.ctaAction.trim().slice(0, 120) : null;
    // BF_SERVER_BLOCK_v646_COMPLETE_COMMS_v1 - attachments passed through
    // as a JSONB array of {name,contentType,dataUrl} (each capped at
    // ~3MB by the client). MessageThread renders them inline.
    const rawAttach = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const attachments = rawAttach
      .filter((a: any) => a && typeof a.name === "string" && typeof a.dataUrl === "string")
      .slice(0, 5)
      .map((a: any) => ({
        name: String(a.name).slice(0, 200),
        contentType: typeof a.contentType === "string" ? a.contentType.slice(0, 80) : "application/octet-stream",
        dataUrl: String(a.dataUrl).slice(0, 4_500_000),
      }));
    if ((!applicationId && !contactId) || (!body && attachments.length === 0)) {
      return res.status(400).json({
        error: { code: "validation_error", message: "contactId or applicationId, plus body or attachments, required" },
      });
    }
    let resolvedContactId: string | null = contactId || null;
    if (!resolvedContactId && applicationId) {
      const cr = await pool.query<{ contact_id: string | null }>(
        `SELECT contact_id FROM applications WHERE id::text = $1 LIMIT 1`,
        [applicationId],
      );
      resolvedContactId = cr.rows[0]?.contact_id ?? null;
    }
    const __msgMerged = renderMergeTokensComm(body, await mergeCtxForContact({ contactId: resolvedContactId ?? contactId }));
    const staffName = (req as any).user?.name ?? (req as any).user?.email ?? null;
    const { getSilo } = await import("../middleware/silo.js");
    const silo = String(getSilo(res) ?? (req as any).user?.silo ?? "BF").toUpperCase();

    // BF_SERVER_BLOCK_v686_MAYA_CRM_UNIFY_v1 - if this contact has a messenger
    // thread (Talk-to-a-Human / Report-an-Issue), stamp its conversation_id on
    // the outbound reply so the visitor widget's poll
    // (/api/public/conversation/:id/messages, direction='outbound') receives it.
    let replyConversationId: string | null = null;
    if (resolvedContactId) {
      const cc = await pool.query<{ id: string }>(
        `SELECT id FROM communications_conversations
          WHERE contact_id = $1 AND silo = $2 AND channel = 'messenger'
          ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
        [resolvedContactId, silo],
      );
      replyConversationId = cc.rows[0]?.id ?? null;
    }

    const id = (await import("node:crypto")).randomUUID();
    await pool.query(
      `INSERT INTO communications_messages
         (id, type, direction, status, application_id, contact_id, conversation_id, silo,
          body, staff_name, cta_label, cta_action, attachments, created_at)
       VALUES (
         $1, 'message', 'outbound', 'sent',
         NULLIF($2, '')::uuid,
         NULLIF($3, '')::uuid,
         $10::uuid,
         $4, $5, $6, $7, $8,
         CASE WHEN $9::text = '[]' THEN NULL ELSE $9::jsonb END,
         now()
       )`,
      [id, applicationId, resolvedContactId ?? "", silo, __msgMerged, staffName, ctaLabel, ctaAction, JSON.stringify(attachments), replyConversationId],
    );
    // BF_SERVER_BLOCK_v686_MAYA_CRM_UNIFY_v1 - bump the messenger thread preview
    // so it reorders in the staff list and the visitor sees fresh activity.
    if (replyConversationId) {
      await pool.query(
        `UPDATE communications_conversations
            SET last_message_preview = $2, last_message_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [replyConversationId, String(__msgMerged || "").slice(0, 280)],
      ).catch(() => undefined);
    }

    // BF_SERVER_BLOCK_v636_MESSAGES_TAB_FIXES_v1: offline-fallback SMS.
    // Mini-portal bumps applications.last_portal_seen_at on every poll (~20s).
    // No bump in 60s -> treat as offline -> SMS the contact with a deep-link.
    // SMS-only client comms - no email.
    try {
      const presence = await pool.query<{
        last_seen: string | null;
        phone: string | null;
        seconds_since: number | null;
      }>(
        `SELECT MAX(a.last_portal_seen_at) AS last_seen,
                MAX(c.phone)               AS phone,
                EXTRACT(EPOCH FROM (now() - MAX(a.last_portal_seen_at)))::int AS seconds_since
           FROM contacts c
           LEFT JOIN applications a ON a.contact_id = c.id
          WHERE c.id = NULLIF($1, '')::uuid
             OR a.id::text = $2`,
        [resolvedContactId ?? "", applicationId],
      );
      const row = presence.rows[0];
      const stale = !row || row.last_seen == null ||
                    (typeof row.seconds_since === "number" && row.seconds_since > 60);
      if (stale && row?.phone) {
        const { sendSms } = await import("../modules/notifications/sms.service.js");
        const clientBase = String(process.env.CLIENT_URL ?? "https://client.boreal.financial").replace(/\/$/, "");
        const link = applicationId
          ? `${clientBase}/portal/${encodeURIComponent(applicationId)}`
          : `${clientBase}/portal`;
        const preview = body.length > 120 ? body.slice(0, 117) + "..." : body;
        const smsBody = `Boreal: ${preview}
${link}`;
        void sendSms({ to: row.phone, message: smsBody }).catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err);
          console.error("[messages/send] offline-fallback sendSms failed", m);
        });
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error("[messages/send] presence check failed", m);
    }

    res.status(201).json({
      id,
      body,
      senderType: "staff",
      senderName: staffName,
      source: "staff",
      createdAt: new Date().toISOString(),
      readAt: null,
      status: "delivered",
      ctaLabel,
      ctaAction,
    });
  }),
);

// -------------------------------------------------------------------------
// BF_SERVER_BLOCK_v646_COMPLETE_COMMS_v1 - read receipts, typing indicators,
// SSE message stream. All endpoints are contact-keyed to match v644.
// -------------------------------------------------------------------------

router.post(
  "/messages/mark-read",
  safeHandler(async (req: any, res: any) => {
    const rawContact = typeof req.body?.contactId === "string" ? req.body.contactId.trim() : "";
    const phoneIn = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
    const throughTs = typeof req.body?.throughTs === "string" ? req.body.throughTs : null;
    if (!rawContact && !phoneIn) {
      return res.status(400).json({ error: { code: "validation_error", message: "contactId or phone required" } });
    }
    const cutoff = throughTs && !Number.isNaN(Date.parse(throughTs)) ? throughTs : new Date().toISOString();
    const isUuid = /^[0-9a-f-]{36}$/i.test(rawContact);
    // BF_SERVER_BLOCK_v689_MARK_READ_ALL_TYPES_v1 - clear read_at for EVERY
    // inbound row for this contact, not just type='message'. SMS rows carry
    // type='sms', so the old filter left them permanently unread - the unread
    // count queries count all inbound regardless of type, so the nav badge and
    // per-thread tags stayed stuck (the "16"/"1" that never cleared on open).
    let r: any;
    if (isUuid) {
      r = await pool.query(
        `UPDATE communications_messages
            SET read_at = NOW()
          WHERE direction = 'inbound'
            AND read_at IS NULL
            AND contact_id = $1::uuid
            AND created_at <= $2::timestamptz`,
        [rawContact, cutoff],
      );
    } else {
      // BF_SERVER_BLOCK_v840_MARK_READ_ORPHAN_SMS_v1 - orphan inbound SMS (from a
      // number with no CRM contact) thread by from_number, not a uuid; clear by
      // from_number so the SMS badge can finally reach zero.
      const phone = phoneIn || rawContact;
      const compact = phone.replace(/[^\d]/g, "");
      const e164 = phone.startsWith("+") ? phone : `+${compact}`;
      r = await pool.query(
        `UPDATE communications_messages
            SET read_at = NOW()
          WHERE direction = 'inbound'
            AND read_at IS NULL
            AND contact_id IS NULL
            AND from_number IN ($1, $2, $3)
            AND created_at <= $4::timestamptz`,
        [phone, e164, compact, cutoff],
      );
    }
    res.json({ ok: true, updated: r.rowCount ?? 0 });
  }),
);

router.post(
  "/messages/typing",
  safeHandler(async (req: any, res: any) => {
    const contactId = typeof req.body?.contactId === "string" ? req.body.contactId.trim() : "";
    const side = req.body?.side === "client" ? "client" : "staff";
    const label = typeof req.body?.label === "string" ? req.body.label.slice(0, 80) : null;
    if (!contactId) {
      return res.status(400).json({ error: { code: "validation_error", message: "contactId required" } });
    }
    await pool.query(
      `INSERT INTO messages_typing (contact_id, side, actor_label, updated_at)
       VALUES (NULLIF($1, '')::uuid, $2, $3, NOW())
       ON CONFLICT (contact_id, side)
       DO UPDATE SET actor_label = EXCLUDED.actor_label, updated_at = NOW()`,
      [contactId, side, label],
    );
    res.json({ ok: true });
  }),
);

router.get(
  "/messages/typing",
  safeHandler(async (req: any, res: any) => {
    const contactId = typeof req.query?.contactId === "string" ? String(req.query.contactId).trim() : "";
    const side = req.query?.side === "client" ? "client" : "staff";
    if (!contactId) {
      return res.status(400).json({ error: { code: "validation_error", message: "contactId required" } });
    }
    const r = await pool.query<{ actor_label: string | null; updated_at: string }>(
      `SELECT actor_label, updated_at
         FROM messages_typing
        WHERE contact_id = NULLIF($1, '')::uuid
          AND side = $2
          AND updated_at > NOW() - INTERVAL '5 seconds'`,
      [contactId, side],
    );
    res.json({ typing: r.rows.length > 0, label: r.rows[0]?.actor_label ?? null });
  }),
);

router.get(
  "/messages/stream",
  safeHandler(async (req: any, res: any) => {
    const contactId = typeof req.query?.contactId === "string" ? String(req.query.contactId).trim() : "";
    if (!contactId) {
      return res.status(400).end();
    }
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
    const tick = async () => {
      try {
        const r = await pool.query<any>(
          `SELECT id, body, direction, staff_name, read_at, cta_label, cta_action,
                  attachments, created_at
             FROM communications_messages
            WHERE type = 'message'
              AND contact_id = NULLIF($1, '')::uuid
              AND created_at > $2
            ORDER BY created_at ASC`,
          [contactId, lastSeenAt.toISOString()],
        );
        for (const row of r.rows) {
          res.write(`event: message\ndata: ${JSON.stringify(row)}\n\n`);
          lastSeenAt = new Date(row.created_at);
        }
        const t = await pool.query<{ side: string; actor_label: string | null }>(
          `SELECT side, actor_label FROM messages_typing
            WHERE contact_id = NULLIF($1, '')::uuid
              AND updated_at > NOW() - INTERVAL '5 seconds'`,
          [contactId],
        );
        res.write(`event: typing\ndata: ${JSON.stringify(t.rows)}\n\n`);
      } catch { /* swallow */ }
    };
    const interval = setInterval(tick, 3000);
    void tick();
    req.on("close", () => clearInterval(interval));
  }),
);


// BF_SERVER_BLOCK_v683_UNIFIED_INBOX_v1
// Contact-list inbox + two-way thread on the CANONICAL store
// (communications_conversations / communications_messages) - the tables that
// actually hold conversation data. chat_sessions/chat_messages are empty/dead.
// Surfaces EVERY channel incl. the "messenger" handoffs from website/client
// "Talk to a Human", newest conversation first, and lets staff reply.

router.get("/inbox", safeHandler(async (req: any, res: any) => {
  const { getSilo } = await import("../middleware/silo.js");
  const silo = getSilo(res);
  const result = await pool.query(
    `SELECT
       cc.id, cc.channel, cc.contact_id,
       COALESCE(c.name, cc.contact_name, cc.contact_phone, 'Unknown') AS display_name,
       COALESCE(c.phone, cc.contact_phone) AS phone,
       cc.last_message_preview, cc.last_message_at, cc.unread
     FROM communications_conversations cc
     LEFT JOIN contacts c ON c.id = cc.contact_id
     WHERE cc.silo = $1
     ORDER BY cc.last_message_at DESC NULLS LAST
     LIMIT 1000`,
    [silo],
  );
  res.json({ conversations: result.rows });
}));

router.get("/inbox/:id/messages", safeHandler(async (req: any, res: any) => {
  const conversationId = String(req.params.id ?? "");
  if (!conversationId) return res.status(400).json({ error: "conversation_id_required" });
  const result = await pool.query(
    `SELECT id, conversation_id, channel, direction, body, created_at
       FROM communications_messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC
      LIMIT 2000`,
    [conversationId],
  );
  res.json({ messages: result.rows });
}));

router.post(
  "/inbox/:id/reply",
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any) => {
    const { getSilo } = await import("../middleware/silo.js");
    const silo = getSilo(res);
    const conversationId = String(req.params.id ?? "");
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!conversationId) return res.status(400).json({ error: "conversation_id_required" });
    if (!body) return res.status(400).json({ error: "body_required" });
    const conv = await pool.query(
      `SELECT id, channel FROM communications_conversations WHERE id = $1 AND silo = $2`,
      [conversationId, silo],
    );
    if (conv.rowCount === 0) return res.status(404).json({ error: "conversation_not_found" });
    const channel = conv.rows[0].channel ?? "messenger";
    const inserted = await pool.query(
      `INSERT INTO communications_messages
         (id, conversation_id, channel, direction, body, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'outbound', $3, NOW())
       RETURNING id, conversation_id, channel, direction, body, created_at`,
      [conversationId, channel, body],
    );
    await pool.query(
      `UPDATE communications_conversations
          SET last_message_preview = $2, last_message_at = NOW(), unread = 0, updated_at = NOW()
        WHERE id = $1`,
      [conversationId, body.slice(0, 200)],
    );
    res.status(201).json({ ok: true, message: inserted.rows[0] });
  }),
);

// BF_SERVER_BLOCK_v795_BROADCAST - multi-send: one outbound per selected contact
// (individual 1:1 sends, NOT a group thread), mirroring POST /sms (Twilio + persist)
// for channel 'sms' and posting a messenger row for channel 'message'. Each row is
// logged to that contact's timeline with the resolved silo. Hard cap of 500.
router.post("/broadcast", safeHandler(async (req: any, res: any) => {
  const { contactIds, body, channel } = req.body ?? {};
  const ch = channel === "message" ? "message" : "sms";
  if (!Array.isArray(contactIds) || contactIds.length === 0 || !body) {
    return res.status(400).json({ error: { message: "contactIds and body are required", code: "validation_error" } });
  }
  const ids = Array.from(new Set(contactIds.map((x: any) => String(x).trim())))
    .filter((x) => /^[0-9a-f-]{36}$/i.test(x))
    .slice(0, 500);
  if (!ids.length) return res.status(400).json({ error: { message: "no valid contactIds", code: "validation_error" } });

  const { resolveSiloFromRequest } = await import("../middleware/silo.js");
  const silo = resolveSiloFromRequest(req);
  const staffName = (req as any).user?.name ?? (req as any).user?.email ?? null;

  const { rows: contacts } = await pool.query<{ id: string; phone: string | null; name: string | null }>(
    `SELECT id, phone, name FROM contacts WHERE id = ANY($1::uuid[])`, [ids],
  );

  let client: any = null;
  let from: string | undefined;
  if (ch === "sms") {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    from = process.env.TWILIO_FROM_NUMBER ?? process.env.TWILIO_PHONE_NUMBER ?? process.env.TWILIO_FROM ?? process.env.TWILIO_PHONE ?? process.env.TWILIO_NUMBER;
    if (!accountSid || !authToken || !from) {
      return res.status(503).json({ error: { message: "SMS not configured", code: "service_unavailable" } });
    }
    client = twilio(accountSid, authToken);
  }

  const results: Array<{ contactId: string; ok: boolean; error?: string }> = [];
  for (const c of contacts) {
    try {
      const appRow = await pool.query<{ id: string }>(
        `SELECT id FROM applications WHERE contact_id = $1 ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST LIMIT 1`, [c.id],
      ).catch(() => ({ rows: [] as any[] }));
      const applicationId = appRow.rows[0]?.id ?? null;
      const ctx = await mergeCtxForContact({ contactId: c.id, phone: c.phone });
      const mergedBody = renderMergeTokensComm(String(body), ctx);

      if (ch === "sms") {
        if (!c.phone) { results.push({ contactId: c.id, ok: false, error: "no_phone" }); continue; }
        const digits = String(c.phone).replace(/\D/g, "");
        const to = digits.length === 10 ? `+1${digits}` : String(c.phone);
        const msg = await client.messages.create({ body: String(mergedBody), from, to });
        await pool.query(
          `INSERT INTO communications_messages
             (id, type, direction, status, body, phone_number, from_number, to_number, twilio_sid, contact_id, application_id, staff_name, silo, created_at)
           VALUES (gen_random_uuid(), 'sms', 'outbound', $1, $2, $3, $4, $3, $5, $6, $7, $8, $9, now())`,
          [msg.status, String(mergedBody), to, from, msg.sid, c.id, applicationId, staffName, silo],
        );
      } else {
        await pool.query(
          `INSERT INTO communications_messages
             (id, type, direction, status, body, contact_id, application_id, staff_name, silo, created_at)
           VALUES (gen_random_uuid(), 'message', 'outbound', 'sent', $1, $2, $3, $4, $5, now())`,
          [String(mergedBody), c.id, applicationId, staffName, silo],
        );
      }
      results.push({ contactId: c.id, ok: true });
    } catch {
      results.push({ contactId: c.id, ok: false, error: "send_failed" });
    }
  }
  for (const id of ids.filter((x) => !contacts.some((c) => c.id === x))) {
    results.push({ contactId: id, ok: false, error: "not_found" });
  }

  return res.json({
    ok: true,
    channel: ch,
    requested: ids.length,
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}));

export default router;
