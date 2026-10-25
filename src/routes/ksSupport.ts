// BF_SERVER_v853_KS_PHONE_SUPPORT - /api/ks/support: the Keystone support queue and the Keystone phone line settings.
//   POST  /api/ks/support/ingest                 KS-Ops / KS-server in-app help (X-KS-Ops-Key = KS_OPS_CRM_KEY)
//   GET   /api/ks/support/tickets                the queue (?status=active|new|open|waiting|resolved|closed|all,
//                                                ?assignee=me|unassigned|<id>, ?priority=, ?channel=, ?q=, ?company_id=, ?contact_id=)
//   POST  /api/ks/support/tickets                a ticket staff open by hand (channel manual, or phone / email)
//   GET   /api/ks/support/tickets/:id            the ticket and its thread
//   PATCH /api/ks/support/tickets/:id            status, priority, assignee, subject, contact, company
//   POST  /api/ks/support/tickets/:id/notes      internal note
//   POST  /api/ks/support/tickets/:id/reply      reply by email (Graph) or SMS (Twilio) { channel, body, status? }
//   GET   /api/ks/support/staff                  who a ticket can be assigned to / who can be in a ring group
//   GET   /api/ks/support/phone                  the Keystone line: configured?, number, both queues' settings
//   PUT   /api/ks/support/phone/queues/:queue    Admin: ring group, ring time, opening hours of sales / support
// Staff access is the Keystone CRM rule (Admins, and staff whose silo access includes KS); everything is silo KS.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { pool } from "../db.js";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { canUseKsCrm } from "../modules/ks/ksCrm.js";
import { KS_OPS_KEY_MIN_LENGTH, opsKeyMatches } from "./ksCrm.js";
import {
  isKsQueue, KS_QUEUES, ksVoiceNumber, loadQueueSettings, parseQueueSettings, saveQueueSettings,
} from "../modules/ks/ksPhone.js";
import {
  addNote, createTicket, getTicket, ingestKsTicket, isKsStaff, isTicketChannel, isTicketPriority, isUuid, KS_SLA_POLICY,
  KS_SUPPORT_LEVELS, KS_TICKET_CHANNELS, KS_TICKET_PRIORITIES, KS_TICKET_STATUS_LABELS, KS_TICKET_STATUSES, ksSupportFromAddress,
  listKsStaff, listTickets, parseKsIngest, parseReply, parseTicketPatch, replyToTicket, updateTicket,
} from "../modules/ks/ksSupport.js";

const router = Router();

function configuredKey(): string | null {
  const key = String(process.env.KS_OPS_CRM_KEY ?? "").trim();
  return key.length >= KS_OPS_KEY_MIN_LENGTH ? key : null;
}

const ingestLimiter = rateLimit({
  windowMs: 60_000,
  keyGenerator: rateLimitKeyFromRequest, // Azure sends ip:port; the library default rejects it
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited" },
});

router.post("/ingest", ingestLimiter, safeHandler(async (req: any, res: any) => {
  const expected = configuredKey();
  if (!expected) return res.status(503).json({ error: "ks_support_not_configured" });
  const header = req.header("x-ks-ops-key");
  const provided = String(Array.isArray(header) ? header[0] : header ?? "").trim();
  if (!provided || !opsKeyMatches(provided, expected)) return res.status(401).json({ error: "invalid_ops_key" });
  const parsed = parseKsIngest(req.body);
  if (!parsed.ok) return res.status(400).json({ error: "validation_error", errors: parsed.errors });
  const client = await pool.connect();
  let out;
  try {
    await client.query("BEGIN");
    out = await ingestKsTicket(client, parsed.value);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr: unknown) => {
      console.error("[ks-support] rollback failed", rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr));
    });
    throw err;
  } finally {
    client.release();
  }
  return res.status(out.created ? 201 : 200).json({ ok: true, ...out, silo: "KS" });
}));

// Staff side.
router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.CRM_READ]));
router.use((req: any, res: any, next: any) => {
  if (!canUseKsCrm(req.user)) return res.status(403).json({ error: "ks_access_required" });
  return next();
});

const actorOf = async (req: any): Promise<{ userId: string | null; name: string | null }> => {
  const userId = String(req.user?.userId ?? req.user?.id ?? "").trim();
  if (!isUuid(userId)) return { userId: null, name: null };
  const r = await pool.query(
    `SELECT NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), '') AS name, email FROM users WHERE id = $1::uuid`,
    [userId],
  );
  return { userId, name: r.rows[0]?.name ?? r.rows[0]?.email ?? null };
};
const isAdmin = (req: any) => String(req.user?.role ?? "").toLowerCase() === "admin";

router.get("/meta", safeHandler(async (_req: any, res: any) => {
  res.json({
    ok: true,
    statuses: KS_TICKET_STATUSES.map((key) => ({ key, label: KS_TICKET_STATUS_LABELS[key] })),
    priorities: KS_TICKET_PRIORITIES,
    channels: KS_TICKET_CHANNELS,
    support_levels: KS_SUPPORT_LEVELS.map((key) => ({ key, label: KS_SLA_POLICY[key].label, target: KS_SLA_POLICY[key].target })),
  });
}));

router.get("/tickets", safeHandler(async (req: any, res: any) => {
  const s = (k: string) => (typeof req.query[k] === "string" ? req.query[k] : null);
  const tickets = await listTickets(pool, {
    status: s("status"), assignee: s("assignee"), priority: s("priority"), channel: s("channel"),
    companyId: s("company_id"), contactId: s("contact_id"), search: s("q"), userId: req.user?.userId ?? req.user?.id ?? null,
  });
  res.json({ ok: true, silo: "KS", tickets });
}));

router.post("/tickets", requireCapability([CAPABILITIES.CRM_WRITE]), safeHandler(async (req: any, res: any) => {
  const b = req.body ?? {};
  const errors: Record<string, string> = {};
  const subject = typeof b.subject === "string" ? b.subject.trim() : "";
  if (!subject || subject.length > 200) errors.subject = "must be 1 to 200 characters";
  const body = typeof b.body === "string" ? b.body.trim() : "";
  if (body.length > 20000) errors.body = "must be 20000 characters or fewer";
  const channel = b.channel === undefined ? "manual" : b.channel;
  if (!isTicketChannel(channel)) errors.channel = "must be phone, email, in_app or manual";
  const priority = b.priority === undefined ? "normal" : b.priority;
  if (!isTicketPriority(priority)) errors.priority = "must be low, normal, high or urgent";
  for (const k of ["contact_id", "company_id", "assignee_user_id"]) {
    if (b[k] !== undefined && b[k] !== null && b[k] !== "" && !isUuid(b[k])) errors[k] = "must be an id";
  }
  if (Object.keys(errors).length) return res.status(400).json({ error: "validation_error", errors });
  const actor = await actorOf(req);
  const contactId = isUuid(b.contact_id) ? b.contact_id : null;
  let companyId = isUuid(b.company_id) ? b.company_id : null;
  if (contactId) {
    const c = await pool.query(`SELECT company_id::text AS company_id FROM contacts WHERE id = $1::uuid AND silo = 'KS'`, [contactId]);
    if (!c.rows[0]) return res.status(400).json({ error: "contact_not_keystone" });
    companyId = companyId ?? c.rows[0].company_id ?? null;
  }
  if (companyId) {
    const c = await pool.query(`SELECT 1 FROM companies WHERE id = $1::uuid AND silo = 'KS'`, [companyId]);
    if (!c.rows[0]) return res.status(400).json({ error: "company_not_keystone" });
  }
  const assignee = isUuid(b.assignee_user_id) ? b.assignee_user_id : null;
  if (assignee && !(await isKsStaff(pool, assignee))) return res.status(400).json({ error: "assignee_not_keystone_staff" });
  const out = await createTicket(pool, {
    subject, channel, priority, companyId, contactId, assigneeUserId: assignee, createdByUserId: actor.userId,
    firstMessage: body ? { kind: "customer", channel, body, authorName: actor.name ? `Logged by ${actor.name}` : null } : null,
  });
  return res.status(201).json({ ok: true, id: out.id, number: out.number, silo: "KS" });
}));

router.get("/tickets/:id", safeHandler(async (req: any, res: any) => {
  const out = await getTicket(pool, String(req.params.id));
  if (!out) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true, silo: "KS", ...out });
}));

router.patch("/tickets/:id", requireCapability([CAPABILITIES.CRM_WRITE]), safeHandler(async (req: any, res: any) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: "not_found" });
  const parsed = parseTicketPatch(req.body);
  if (!parsed.ok) return res.status(400).json({ error: "validation_error", errors: parsed.errors });
  const out = await updateTicket(pool, req.params.id, parsed.value, await actorOf(req));
  if (!out.ok) return res.status(out.status).json({ error: out.error });
  const fresh = await getTicket(pool, req.params.id);
  res.json({ ok: true, silo: "KS", ...(fresh ?? {}) });
}));

router.post("/tickets/:id/notes", requireCapability([CAPABILITIES.CRM_WRITE]), safeHandler(async (req: any, res: any) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: "not_found" });
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body || body.length > 20000) return res.status(400).json({ error: "validation_error", errors: { body: "must be 1 to 20000 characters" } });
  const exists = await pool.query(`SELECT 1 FROM ks_support_tickets WHERE id = $1::uuid`, [req.params.id]);
  if (!exists.rows[0]) return res.status(404).json({ error: "not_found" });
  const id = await addNote(pool, req.params.id, body, await actorOf(req));
  res.status(201).json({ ok: true, id });
}));

router.post("/tickets/:id/reply", requireCapability([CAPABILITIES.CRM_WRITE]), safeHandler(async (req: any, res: any) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: "not_found" });
  const parsed = parseReply(req.body);
  if (!parsed.ok) return res.status(400).json({ error: "validation_error", errors: parsed.errors });
  const out = await replyToTicket(pool, req.params.id, parsed.value, await actorOf(req));
  if (!out.ok) return res.status(out.status).json({ error: out.error, message: out.message });
  res.status(201).json({ ok: true, to: out.to });
}));

router.get("/staff", safeHandler(async (_req: any, res: any) => {
  res.json({ ok: true, staff: await listKsStaff(pool) });
}));

router.get("/phone", safeHandler(async (_req: any, res: any) => {
  const queues = [];
  for (const q of KS_QUEUES) queues.push(await loadQueueSettings(pool, q));
  const base = (process.env.PUBLIC_BASE_URL || "https://server.boreal.financial").replace(/\/+$/, "");
  res.json({
    ok: true,
    configured: ksVoiceNumber() !== null,
    number: ksVoiceNumber(),
    voice_url: `${base}/api/webhooks/twilio/ks/voice`,
    status_callback_url: `${base}/api/webhooks/twilio/voice`,
    support_email: ksSupportFromAddress() || null,
    queues,
  });
}));

router.put("/phone/queues/:queue", safeHandler(async (req: any, res: any) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admin_required" });
  const queue = req.params.queue;
  if (!isKsQueue(queue)) return res.status(404).json({ error: "not_found" });
  const parsed = parseQueueSettings(queue, req.body);
  if (!parsed.ok) return res.status(400).json({ error: "validation_error", errors: parsed.errors });
  for (const id of parsed.value.ringUserIds) {
    if (!(await isKsStaff(pool, id))) return res.status(400).json({ error: "validation_error", errors: { ringUserIds: "everyone in the ring group needs Keystone access" } });
  }
  const actor = await actorOf(req);
  const saved = await saveQueueSettings(pool, parsed.value, actor.userId);
  res.json({ ok: true, queue: saved });
}));

export default router;
