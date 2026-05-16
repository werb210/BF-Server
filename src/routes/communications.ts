import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import twilio from "twilio";

const router = Router();
router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.COMMUNICATIONS_READ]));

router.get("/", safeHandler((_req: any, res: any) => {
  res.json({ status: "ok" });
}));

// GET /api/communications/messages — queries the actual DB.
// BF_SERVER_v65_COMMS_NO_400 — when contact_id is absent, return an empty
// list with 200 instead of 400. Portal Communications page calls this
// before any thread is selected; the previous 400 just spammed the
// console without changing the rendered empty-state.
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
      `SELECT id, body, contact_id, direction, from_number, to_number, silo, created_at
       FROM communications_messages
       WHERE contact_id = $1
         AND silo = $2
       ORDER BY created_at ASC
      `,
      [contactId, silo]
    );
    res.json({ messages: result.rows, total: result.rows.length });
  } catch {
    res.json({ messages: [], total: 0 });
  }
}));

router.get("/sms", safeHandler(async (req: any, res: any) => {
  const { getSilo } = await import("../middleware/silo.js");
  const silo = getSilo(res);
  const result = await pool.query(
    `SELECT
      COALESCE(c.id::text, m.from_number) AS thread_key,
      c.id    AS contact_id,
      COALESCE(c.name, m.from_number, m.to_number) AS display_name,
      COALESCE(c.phone, m.from_number, m.to_number) AS phone,
      MAX(m.created_at) AS last_at,
      (SELECT body FROM communications_messages
         WHERE COALESCE(contact_id::text, from_number) =
               COALESCE(c.id::text, m.from_number)
         ORDER BY created_at DESC LIMIT 1) AS last_body,
      SUM(CASE WHEN m.read_at IS NULL AND m.direction='inbound' THEN 1 ELSE 0 END) AS unread_count
    FROM communications_messages m
    LEFT JOIN contacts c ON c.id = m.contact_id
    WHERE m.silo = $1
    GROUP BY thread_key, c.id, display_name, phone
    ORDER BY last_at DESC
    LIMIT 200`,
    [silo]
  ).catch(() => ({ rows: [] as any[] }));
  res.json({ conversations: result.rows });
}));


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
    params.push(contactId);
    where += ` AND contact_id = $${params.length}`;
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
              created_at, read_at
       FROM communications_messages
       WHERE ${where}
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

// BF_SERVER_BLOCK_BI_ROUND6_THREADS_LIST_v1
// GET /api/communications/threads
// Returns the list of active (non-closed) chat sessions scoped to
// the caller's silo (via Block 13's resolveSiloFromRequest fix --
// after that block, res.locals.silo carries the correct silo on
// every authed route). Used by the staff Communications page to
// populate the session list.
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

  const sql = `
    SELECT
      s.id,
      s.id AS session_id,
      s.source,
      s.status,
      s.assigned_to,
      s.crm_contact_id,
      s.created_at,
      s.updated_at,
      c.silo AS contact_silo,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone,
      (
        SELECT content FROM chat_messages m
        WHERE m.session_id = s.id
        ORDER BY m.created_at DESC
        LIMIT 1
      ) AS last_message
    FROM chat_sessions s
    LEFT JOIN contacts c ON c.id = s.crm_contact_id
    WHERE s.status <> 'closed'
      AND (c.silo IS NULL OR c.silo = $1)
    ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC
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

  // Map server rows into the portal's CommunicationConversation shape.
  // type is "human" when a staff member is in (status=live), else
  // "chat" for the AI-only sessions; "closed" sessions are excluded
  // by the WHERE clause but still get a defensive branch.
  const conversations = result.rows.map((row: any) => {
    const status =
      row.status === "live" ? "human" :
      row.status === "closed" ? "closed" :
      "ai";
    const type = status === "human" ? "human" : "chat";
    return {
      id: row.id,
      sessionId: row.session_id,
      type,
      status,
      silo: row.contact_silo ?? effectiveSilo,
      contactId: row.crm_contact_id ?? undefined,
      contactName: row.contact_name ?? undefined,
      contactEmail: row.contact_email ?? undefined,
      contactPhone: row.contact_phone ?? undefined,
      assignedTo: row.assigned_to ?? undefined,
      message: row.last_message ?? undefined,
      messages: [] as unknown[],
      updatedAt: row.updated_at ?? row.created_at,
    };
  });

  return res.status(200).json(conversations);
}));

// BF_SERVER_BLOCK_BI_ROUND6_THREADS_DETAIL_v1
// GET /api/communications/threads/:id
// Returns a single chat session payload with the full messages
// array. Staff panel calls this when activeSessionId changes
// so the message area populates with history. The list endpoint
// (Block 20) deliberately returns messages: [] for performance
// and defers message loading to this endpoint.
//
// Silo gate: contact_silo on the joined contact must match the
// caller's resolved silo, unless the caller is an admin. Returns
// 404 (not 403) when no row exists so we don't leak which session
// ids are valid in other silos.
router.get("/threads/:id", safeHandler(async (req: any, res: any) => {
  const { resolveSiloFromRequest } = await import("../middleware/silo.js");
  const silo = resolveSiloFromRequest(req);
  const sessionId = String(req.params.id ?? "").trim();
  if (!sessionId) return res.status(400).json({ error: "missing_session_id" });

  const isAdmin = String(req.user?.role ?? "").toLowerCase() === "admin";

  // Load the session + joined contact info. LEFT JOIN keeps
  // anonymous sessions (no crm_contact_id) addressable -- those
  // have contact_silo=null and pass the silo gate for every silo
  // until they're contact-bound.
  const sessionResult = await pool.query(`
    SELECT
      s.id,
      s.id AS session_id,
      s.source,
      s.status,
      s.assigned_to,
      s.crm_contact_id,
      s.created_at,
      s.updated_at,
      c.silo AS contact_silo,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone
    FROM chat_sessions s
    LEFT JOIN contacts c ON c.id = s.crm_contact_id
    WHERE s.id = $1
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
    SELECT id, session_id, role, content, created_at
    FROM chat_messages
    WHERE session_id = $1
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
    const roleStr = String(m.role ?? "").toLowerCase();
    const direction =
      roleStr === "user" ? "in" :
      (roleStr === "staff" || roleStr === "ai") ? "out" :
      "system";
    return {
      id: m.id,
      conversationId: sessionId,
      type: "chat",
      direction,
      message: m.content ?? "",
      createdAt: m.created_at,
    };
  });

  const status =
    session.status === "live" ? "human" :
    session.status === "closed" ? "closed" :
    "ai";
  const type = status === "human" ? "human" : "chat";

  return res.status(200).json({
    id: session.id,
    sessionId: session.session_id,
    type,
    status,
    silo: session.contact_silo ?? silo,
    contactId: session.crm_contact_id ?? undefined,
    contactName: session.contact_name ?? undefined,
    contactEmail: session.contact_email ?? undefined,
    contactPhone: session.contact_phone ?? undefined,
    assignedTo: session.assigned_to ?? undefined,
    message: messages.length ? messages[messages.length - 1].message : undefined,
    messages,
    updatedAt: session.updated_at ?? session.created_at,
  });
}));

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

  const events = [
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

// POST /api/communications/sms — send outbound + persist to DB
router.post("/sms", safeHandler(async (req: any, res: any) => {
  const { contactId, to, body, applicationId } = req.body ?? {};
  if (!body || !to) {
    return res.status(400).json({ error: { message: "to and body are required", code: "validation_error" } });
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
  const message = await client.messages.create({ body: String(body), from, to: String(to) });

  // Persist outbound message to DB
  // BF_SERVER_BLOCK_v312_COMMS_SMS_PERSIST_LOG_v1
  // Pre-fix this used .catch(() => {}) — the Twilio send had already
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
  await pool.query(
    `INSERT INTO communications_messages
       (id, type, direction, status, body, phone_number, from_number, to_number,
        twilio_sid, contact_id, application_id, staff_name, silo, created_at)
     VALUES (gen_random_uuid(), 'sms', 'outbound', $1, $2, $3, $4, $3, $5, $6, $7, $8, $9, now())`,
    [
      message.status,
      String(body),
      String(to),
      from,
      message.sid,
      contactId ?? null,
      applicationId ?? null,
      staffName,
      silo,
    ]
  ).catch((err: any) => {
    // eslint-disable-next-line no-console
    console.warn("communications.sms.persist_failed", {
      twilioSid: message.sid,
      contactId: contactId ?? null,
      applicationId: applicationId ?? null,
      message: err?.message,
      code: err?.code,
    });
  });

  res.json({ id: message.sid, status: message.status, contactId: contactId ?? null });
}));

export default router;
