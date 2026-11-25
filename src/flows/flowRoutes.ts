// BF_SERVER_CRM_FLOWS_v1 (2026-11-24) - staff API for email flows in the Boreal Financial and Keystone CRMs (Marketing >
// Flows). The business comes from X-Silo, like the rest of /api/crm. Mounted at /api/crm/flows behind requireAuth.
//   GET    /                   this business's flows with their numbers
//   GET    /collateral         PDFs an email can attach
//   GET    /tags               tags in this CRM with how many people can be emailed (the audience picker)
//   POST   /                   { name, audience_tags[], market?, ... } -> a draft with starter wording
//   GET    /:id                one flow with its seven emails
//   PATCH  /:id                change settings or wording
//   POST   /:id/audience       add everyone who matches (again later to pick up new contacts)
//   POST   /:id/test           { to } send all seven emails to one address, marked TEST
//   POST   /:id/start | /pause | /archive
// Only an Admin can create, change, start or pause a flow.
import express, { type Request, type Response } from "express";
import { pool } from "../db.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { mergeFields } from "../services/sendgridService.js";
import { FLOW_KEYS, FLOW_KEY_LABEL, dailyNewCap, htmlToText, isFlowKey, withFooter } from "./flowEngine.js";
import { cleanAttachmentIds, listFlowCollateral, loadFlowAttachments, sendFlowEmail } from "./flowSend.js";
import { starterEmails } from "./flowStarters.js";

const router = express.Router();
const isAdmin = (req: Request) => ["admin", "owner"].includes(String((req as any).user?.role ?? "").toLowerCase());
const adminOnly = (req: Request, res: Response): boolean => {
  if (isAdmin(req)) return true;
  res.status(403).json({ ok: false, error: "admin_only", message: "Only an Admin can change email flows." });
  return false;
};
const text = (v: unknown, max = 200): string | null => { const t = String(v ?? "").trim().slice(0, max); return t || null; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const siloOf = (req: Request) => String(resolveSiloFromRequest(req)).toUpperCase();
const userId = (req: Request) => String((req as any).user?.userId ?? (req as any).user?.id ?? "") || null;
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  fn(req, res).catch((err) => {
    console.error("[flows] route failed", { path: req.path, message: (err as Error)?.message });
    if (!res.headersSent) res.status(500).json({ ok: false, error: "internal_error" });
  });
};
const cleanTags = (raw: unknown): string[] =>
  Array.from(new Set((Array.isArray(raw) ? raw : String(raw ?? "").split(",")).map((t) => String(t ?? "").trim().toLowerCase()).filter(Boolean))).slice(0, 20);

const US_SQL = `(lower(btrim(coalesce(c.address_country, ''))) IN ('us', 'usa', 'united states', 'united states of america')
  OR EXISTS (SELECT 1 FROM unnest(coalesce(c.tags, '{}')) t WHERE lower(btrim(t)) LIKE 'us %'))`;
/** Who a flow is for: people in this business's CRM with one of the flow's tags, in its country, that we may email.
 *  $1 = silo, $2 = tags (lower case). */
export function audienceSql(market: string): string {
  const marketSql = market === "US" ? `AND ${US_SQL}` : market === "CA" ? `AND NOT ${US_SQL}` : "";
  return `
    FROM contacts c
   WHERE c.silo = $1 AND c.merged_into_id IS NULL AND coalesce(c.status, 'active') <> 'archived'
     AND c.email IS NOT NULL AND position('@' in c.email) > 1 AND c.marketing_opt_out = false
     AND EXISTS (SELECT 1 FROM unnest(coalesce(c.tags, '{}')) t WHERE lower(btrim(t)) = ANY($2::text[]))
     ${marketSql}
     AND NOT EXISTS (SELECT 1 FROM email_suppressions s WHERE lower(s.email) = lower(btrim(c.email)) AND (s.brands IS NULL OR $1 = ANY (s.brands)))`; // BF_SERVER_BRAND_UNSUBSCRIBES_v1
}

const COUNTS_SQL = `
  SELECT f.id, f.silo, f.name, f.audience_tags, f.market, f.status, f.daily_new, f.from_name, f.from_email, f.reply_to,
         f.owner_user_id, f.owner_name, f.link_url, f.booking_url, f.started_at, f.created_at,
         count(m.id)::int AS people,
         count(m.id) FILTER (WHERE m.status = 'queued')::int AS waiting,
         count(m.id) FILTER (WHERE m.first_sent_at IS NOT NULL)::int AS emailed,
         count(m.id) FILTER (WHERE m.track = 'none' AND m.first_sent_at IS NOT NULL)::int AS not_opened,
         count(m.id) FILTER (WHERE m.track = 'opened')::int AS opened,
         count(m.id) FILTER (WHERE m.track = 'clicked')::int AS clicked,
         count(m.id) FILTER (WHERE m.status = 'stopped')::int AS stopped,
         COALESCE(sum(cardinality(m.sent_keys)), 0)::int AS emails_sent
    FROM crm_flows f LEFT JOIN crm_flow_members m ON m.flow_id = f.id
   WHERE f.status <> 'archived' AND f.silo = $1`;

router.get("/collateral", wrap(async (req, res) => {
  res.json({ ok: true, items: await listFlowCollateral(siloOf(req)) });
}));

router.get("/tags", wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT lower(btrim(t)) AS tag, count(DISTINCT c.id)::int AS people,
            count(DISTINCT c.id) FILTER (WHERE c.email IS NOT NULL AND position('@' in c.email) > 1 AND c.marketing_opt_out = false)::int AS emailable
       FROM contacts c, unnest(coalesce(c.tags, '{}')) t
      WHERE c.silo = $1 AND c.merged_into_id IS NULL AND btrim(t) <> ''
      GROUP BY 1 ORDER BY 2 DESC LIMIT 200`,
    [siloOf(req)],
  );
  res.json({ ok: true, tags: r.rows });
}));

router.get("/", wrap(async (req, res) => {
  const r = await pool.query(`${COUNTS_SQL} GROUP BY f.id ORDER BY f.created_at`, [siloOf(req)]);
  const now = new Date();
  res.json({ ok: true, flows: r.rows.map((f) => ({ ...f, new_today_limit: dailyNewCap(f.daily_new, f.started_at ? new Date(f.started_at) : null, now) })) });
}));

router.post("/", wrap(async (req, res) => {
  if (!adminOnly(req, res)) return;
  const silo = siloOf(req);
  const name = text(req.body?.name, 120);
  const tags = cleanTags(req.body?.audience_tags);
  if (!name) return res.status(400).json({ ok: false, error: "name_required", message: "Give the flow a name." });
  if (!tags.length) return res.status(400).json({ ok: false, error: "tags_required", message: "Pick at least one tag: the flow emails people with those tags." });
  const market = ["US", "CA"].includes(String(req.body?.market ?? "").toUpperCase()) ? String(req.body.market).toUpperCase() : "ALL";
  const fromEmail = text(req.body?.from_email, 200);
  const replyTo = text(req.body?.reply_to, 200);
  if (fromEmail && !EMAIL.test(fromEmail)) return res.status(400).json({ ok: false, error: "bad_from", message: "The from address is not an email address." });
  if (replyTo && !EMAIL.test(replyTo)) return res.status(400).json({ ok: false, error: "bad_reply_to", message: "The reply-to address is not an email address." });
  const daily = Math.max(1, Math.min(1000, Math.trunc(Number(req.body?.daily_new) || 100)));
  const ownerId = text(req.body?.owner_user_id, 80);
  const r = await pool.query(
    `INSERT INTO crm_flows (silo, name, audience_tags, market, daily_new, from_name, from_email, reply_to, owner_user_id, owner_name, link_url, booking_url, emails, created_by)
     VALUES ($1,$2,$3::text[],$4,$5,$6,$7,$8,$9::uuid,$10,$11,$12,$13::jsonb,$14::uuid) RETURNING id`,
    [silo, name, tags, market, daily, text(req.body?.from_name, 120), fromEmail, replyTo, ownerId && UUID.test(ownerId) ? ownerId : null,
      text(req.body?.owner_name, 120), text(req.body?.link_url, 500), text(req.body?.booking_url, 500), JSON.stringify(starterEmails(silo)), userId(req)],
  );
  res.status(201).json({ ok: true, id: r.rows[0].id });
}));

router.get("/:id", wrap(async (req, res) => {
  if (!UUID.test(String(req.params.id))) return res.status(404).json({ ok: false, error: "not_found" });
  const silo = siloOf(req);
  const r = await pool.query(`${COUNTS_SQL} AND f.id = $2 GROUP BY f.id`, [silo, req.params.id]);
  if (!r.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
  const e = await pool.query(`SELECT emails FROM crm_flows WHERE id = $1`, [req.params.id]);
  const emails = e.rows[0]?.emails ?? {};
  const flow = r.rows[0];
  const waiting = await pool.query(
    `SELECT count(*)::int AS n ${audienceSql(flow.market)} AND NOT EXISTS (SELECT 1 FROM crm_flow_members m WHERE m.flow_id = $3 AND m.contact_id = c.id)`,
    [silo, flow.audience_tags ?? [], req.params.id],
  );
  res.json({ ok: true, flow, not_yet_added: waiting.rows[0]?.n ?? 0,
    emails: FLOW_KEYS.map((key) => ({ key, label: FLOW_KEY_LABEL[key], subject: emails[key]?.subject ?? "", body: emails[key]?.body ?? "", attachments: Array.isArray(emails[key]?.attachments) ? emails[key].attachments : [] })) });
}));

router.patch("/:id", wrap(async (req, res) => {
  if (!adminOnly(req, res)) return;
  if (!UUID.test(String(req.params.id))) return res.status(404).json({ ok: false, error: "not_found" });
  const cur = await pool.query(`SELECT emails FROM crm_flows WHERE id = $1 AND silo = $2 AND status <> 'archived'`, [req.params.id, siloOf(req)]);
  if (!cur.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
  const b = req.body ?? {};
  const emails = { ...(cur.rows[0].emails ?? {}) } as Record<string, { subject: string; body: string; attachments?: string[] }>;
  if (b.emails && typeof b.emails === "object") {
    for (const [key, v] of Object.entries(b.emails as Record<string, any>)) {
      if (!isFlowKey(key)) continue;
      const subject = String(v?.subject ?? "").trim().slice(0, 200);
      const body = String(v?.body ?? "").trim().slice(0, 20_000);
      if (!subject || !body) return res.status(400).json({ ok: false, error: "empty_email", message: `${FLOW_KEY_LABEL[key]} needs a subject and a message.` });
      const attachments = v?.attachments === undefined ? (emails[key]?.attachments ?? []) : cleanAttachmentIds(v.attachments);
      emails[key] = attachments.length ? { subject, body, attachments } : { subject, body };
    }
  }
  for (const f of ["from_email", "reply_to"] as const) {
    const v = text(b[f], 200);
    if (b[f] !== undefined && v && !EMAIL.test(v)) return res.status(400).json({ ok: false, error: `bad_${f}`, message: "That is not an email address." });
  }
  const tags = b.audience_tags === undefined ? null : cleanTags(b.audience_tags);
  if (tags && !tags.length) return res.status(400).json({ ok: false, error: "tags_required", message: "Pick at least one tag." });
  const daily = b.daily_new === undefined ? null : Math.max(1, Math.min(1000, Math.trunc(Number(b.daily_new) || 100)));
  const market = b.market === undefined ? null : ["US", "CA"].includes(String(b.market).toUpperCase()) ? String(b.market).toUpperCase() : "ALL";
  const ownerId = text(b.owner_user_id, 80);
  await pool.query(
    `UPDATE crm_flows SET emails = $2::jsonb, daily_new = COALESCE($3, daily_new), name = COALESCE($4, name),
            from_name = CASE WHEN $5::boolean THEN $6 ELSE from_name END,
            from_email = CASE WHEN $7::boolean THEN $8 ELSE from_email END,
            reply_to = CASE WHEN $9::boolean THEN $10 ELSE reply_to END,
            owner_user_id = CASE WHEN $11::boolean THEN $12::uuid ELSE owner_user_id END, owner_name = CASE WHEN $11::boolean THEN $13 ELSE owner_name END,
            link_url = COALESCE($14, link_url), booking_url = COALESCE($15, booking_url),
            audience_tags = COALESCE($16::text[], audience_tags), market = COALESCE($17, market), updated_at = now()
      WHERE id = $1`,
    [req.params.id, JSON.stringify(emails), daily, text(b.name, 120), b.from_name !== undefined, text(b.from_name, 120),
      b.from_email !== undefined, text(b.from_email, 200), b.reply_to !== undefined, text(b.reply_to, 200),
      b.owner_user_id !== undefined, ownerId && UUID.test(ownerId) ? ownerId : null, text(b.owner_name, 120),
      text(b.link_url, 500), text(b.booking_url, 500), tags, market],
  );
  res.json({ ok: true });
}));

router.post("/:id/audience", wrap(async (req, res) => {
  if (!adminOnly(req, res)) return;
  if (!UUID.test(String(req.params.id))) return res.status(404).json({ ok: false, error: "not_found" });
  const silo = siloOf(req);
  const f = await pool.query(`SELECT audience_tags, market FROM crm_flows WHERE id = $1 AND silo = $2 AND status <> 'archived'`, [req.params.id, silo]);
  if (!f.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
  const r = await pool.query(
    `INSERT INTO crm_flow_members (flow_id, contact_id, email)
     SELECT DISTINCT ON (lower(btrim(c.email))) $3::uuid, c.id, lower(btrim(c.email)) ${audienceSql(f.rows[0].market)}
        AND NOT EXISTS (SELECT 1 FROM crm_flow_members m WHERE m.flow_id = $3 AND lower(m.email) = lower(btrim(c.email)))
      ORDER BY lower(btrim(c.email)), c.created_at
     ON CONFLICT (flow_id, contact_id) DO NOTHING`,
    [silo, f.rows[0].audience_tags ?? [], req.params.id],
  );
  res.json({ ok: true, added: r.rowCount ?? 0 });
}));

router.post("/:id/test", wrap(async (req, res) => {
  if (!adminOnly(req, res)) return;
  const to = String(req.body?.to ?? "").trim();
  if (!EMAIL.test(to)) return res.status(400).json({ ok: false, error: "bad_email", message: "Enter the email address to send the test to." });
  if (!UUID.test(String(req.params.id))) return res.status(404).json({ ok: false, error: "not_found" });
  const silo = siloOf(req);
  const f = await pool.query(`SELECT * FROM crm_flows WHERE id = $1 AND silo = $2`, [req.params.id, silo]);
  if (!f.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
  const flow = f.rows[0];
  const merge = { first_name: "Sample", full_name: "Sample Person", name: "Sample Person", company: "Sample Company", link: flow.link_url ?? "", booking_link: flow.booking_url ?? "", email: to };
  const fromName = String(flow.from_name ?? "").trim() || (silo === "KS" ? "Keystone" : "Boreal Financial");
  let sent = 0;
  const errors: string[] = [];
  for (const key of FLOW_KEYS) {
    const e = (flow.emails ?? {})[key];
    if (!e?.subject || !e?.body) continue;
    const html = withFooter(mergeFields(String(e.body), merge), fromName, silo, "");
    const files = Array.isArray(e.attachments) && e.attachments.length ? await loadFlowAttachments(e.attachments, silo) : [];
    const r = await sendFlowEmail({ to, subject: `[TEST ${sent + 1}/7 - ${FLOW_KEY_LABEL[key]}] ${mergeFields(String(e.subject), merge)}`, html, text: htmlToText(html),
      fromName, fromEmail: flow.from_email, replyTo: flow.reply_to, customArgs: { flow_test: "1" }, ...(files.length ? { attachments: files } : {}) });
    if (r.ok) sent += 1; else errors.push(r.error ?? "send failed");
  }
  if (!sent && errors.length) return res.status(502).json({ ok: false, error: "send_failed", message: errors[0] });
  res.json({ ok: true, sent });
}));

for (const [action, status] of [["start", "active"], ["pause", "paused"], ["archive", "archived"]] as const) {
  router.post(`/:id/${action}`, wrap(async (req, res) => {
    if (!adminOnly(req, res)) return;
    if (!UUID.test(String(req.params.id))) return res.status(404).json({ ok: false, error: "not_found" });
    if (action === "start") {
      const people = await pool.query(`SELECT count(*)::int AS n FROM crm_flow_members WHERE flow_id = $1`, [req.params.id]);
      if (!Number(people.rows[0]?.n)) return res.status(400).json({ ok: false, error: "no_people", message: "Add the people first." });
    }
    const r = await pool.query(
      `UPDATE crm_flows SET status = $3, started_at = CASE WHEN $3 = 'active' THEN COALESCE(started_at, now()) ELSE started_at END, updated_at = now()
        WHERE id = $1 AND silo = $2 AND status <> 'archived' RETURNING id`,
      [req.params.id, siloOf(req), status],
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, status });
  }));
}

export default router;
