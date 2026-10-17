// v693: message templates (email | message | sms). Shared team library + personal.
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { getSilo } from "../middleware/silo.js";

const router = Router();
router.use(requireAuth);

// BF_SERVER_SNIPPETS_v65 - team added so Team chat shares the same store.
const CHANNELS = new Set(["email", "message", "sms", "team"]);
const isAdmin = (req: any) => String(req.user?.role ?? "").toLowerCase() === "admin";

// BF_SERVER_SNIPPETS_v65 - the catalogue of merge fields, so the composer can
// offer completions rather than expecting people to memorise them.
router.get("/merge-fields", safeHandler(async (_req: any, res: any) => {
  const { MERGE_FIELD_NAMES } = await import("../services/mergeFields.js");
  res.json({ fields: MERGE_FIELD_NAMES });
}));

router.get("/", safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const userId = req.user?.id ?? req.user?.userId ?? null;
  const channel = req.query.channel ? String(req.query.channel) : null;
  // BF_SERVER_SNIPPETS_v65 - ?snippets=1 for the composer's inserter,
  // ?snippets=0 for the template manager, absent for everything.
  const snippetOnly = req.query.snippets == null ? null : String(req.query.snippets) === "1";
  const { rows } = await pool.query(
    `SELECT id, channel, name, subject, body_html, body_text, shared, owner_user_id,
            is_snippet, shortcut, created_at, updated_at
       FROM message_templates
      WHERE silo IN ('BF', $1)
        AND (shared = true OR owner_user_id = $2)
        AND ($3::text IS NULL OR channel = $3)
        AND ($4::boolean IS NULL OR is_snippet = $4)
      ORDER BY is_snippet DESC, name ASC`,
    [silo, userId, channel, snippetOnly]
  );
  res.json({ items: rows });
}));

// BF_SERVER_v821_DIALER - quick replies for the iPhone dialler / Watch: GET / already returns templates AND snippets,
// but every column (HTML bodies included) and no cap. This is the lightweight list:
//   GET /api/templates/quick?channel=sms -> { items: [{ id, name, body, isSnippet }] }  (max 50, snippets first, then name)
// body is the RAW text with merge fields ({{contact.first_name}}) unrendered: POST /api/communications/sms and
// /api/communications/messages/send render them for the recipient on send.
export const QUICK_REPLY_LIMIT = 50;
router.get("/quick", safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const userId = req.user?.id ?? req.user?.userId ?? null;
  const channel = req.query.channel == null ? "sms" : String(req.query.channel).toLowerCase();
  if (!CHANNELS.has(channel)) return res.status(400).json({ error: "invalid_channel" });
  const { rows } = await pool.query(
    `SELECT id::text AS id, name, COALESCE(NULLIF(body_text, ''), body_html, '') AS body, is_snippet
       FROM message_templates
      WHERE silo IN ('BF', $1)
        AND (shared = true OR owner_user_id = $2)
        AND channel = $3
      ORDER BY is_snippet DESC, name ASC
      LIMIT ${QUICK_REPLY_LIMIT}`,
    [silo, userId, channel],
  );
  res.json({
    items: rows.map((r: any) => ({ id: String(r.id), name: String(r.name ?? ""), body: htmlToText(String(r.body ?? "")), isSnippet: r.is_snippet === true })),
  });
}));

/** Plain text for a template that only has an HTML body (merge fields are left untouched). */
function htmlToText(body: string): string {
  if (!/<[a-z][\s\S]*>/i.test(body)) return body;
  return body
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

router.post("/", safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const userId = req.user?.id ?? req.user?.userId ?? null;
  const channel = String(req.body?.channel ?? "").toLowerCase();
  if (!CHANNELS.has(channel)) return res.status(400).json({ error: "invalid_channel" });
  const name = String(req.body?.name ?? "").slice(0, 200);
  if (!name) return res.status(400).json({ error: "name required" });
  const subject = req.body?.subject != null ? String(req.body.subject).slice(0, 400) : null;
  const bodyHtml = req.body?.body_html != null ? String(req.body.body_html).slice(0, 50000) : null;
  const bodyText = req.body?.body_text != null ? String(req.body.body_text).slice(0, 50000) : null;
  const shared = req.body?.shared === false ? false : true;
  const isSnippet = req.body?.is_snippet === true;
  // A shortcut is typed, so it is normalised: lower case, no spaces, no
  // leading hash. "#PNW " and "pnw" are the same shortcut.
  const rawShortcut = req.body?.shortcut != null ? String(req.body.shortcut) : "";
  const shortcut = rawShortcut.trim().replace(/^#+/, "").toLowerCase().slice(0, 40) || null;
  const { rows } = await pool.query(
    `INSERT INTO message_templates (channel, name, subject, body_html, body_text, shared, owner_user_id, silo, created_by, is_snippet, shortcut)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7,$9,$10)
     RETURNING id, channel, name, subject, body_html, body_text, shared, owner_user_id, is_snippet, shortcut, created_at, updated_at`,
    [channel, name, subject, bodyHtml, bodyText, shared, userId, silo, isSnippet, shortcut]
  );
  res.status(201).json({ item: rows[0] });
}));

router.put("/:id", safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const userId = req.user?.id ?? req.user?.userId ?? null;
  const cur = await pool.query(`SELECT owner_user_id, shared FROM message_templates WHERE id = $1 AND silo = $2 LIMIT 1`, [req.params.id, silo]);
  const row = cur.rows[0];
  if (!row) return res.status(404).json({ error: "not_found" });
  if (!(row.owner_user_id === userId || row.shared === true || isAdmin(req))) return res.status(403).json({ error: "forbidden" });
  const name = req.body?.name != null ? String(req.body.name).slice(0, 200) : null;
  const subject = req.body?.subject != null ? String(req.body.subject).slice(0, 400) : null;
  const bodyHtml = req.body?.body_html != null ? String(req.body.body_html).slice(0, 50000) : null;
  const bodyText = req.body?.body_text != null ? String(req.body.body_text).slice(0, 50000) : null;
  const shared = typeof req.body?.shared === "boolean" ? req.body.shared : null;
  const { rows } = await pool.query(
    `UPDATE message_templates SET
        name = COALESCE($3, name),
        subject = COALESCE($4, subject),
        body_html = COALESCE($5, body_html),
        body_text = COALESCE($6, body_text),
        shared = COALESCE($7, shared),
        updated_at = now()
      WHERE id = $1 AND silo = $2
      RETURNING id, channel, name, subject, body_html, body_text, shared, owner_user_id, created_at, updated_at`,
    [req.params.id, silo, name, subject, bodyHtml, bodyText, shared]
  );
  res.json({ item: rows[0] });
}));

router.delete("/:id", safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const userId = req.user?.id ?? req.user?.userId ?? null;
  const cur = await pool.query(`SELECT owner_user_id, shared FROM message_templates WHERE id = $1 AND silo = $2 LIMIT 1`, [req.params.id, silo]);
  const row = cur.rows[0];
  if (!row) return res.status(404).json({ error: "not_found" });
  if (!(row.owner_user_id === userId || row.shared === true || isAdmin(req))) return res.status(403).json({ error: "forbidden" });
  await pool.query(`DELETE FROM message_templates WHERE id = $1 AND silo = $2`, [req.params.id, silo]);
  res.json({ ok: true });
}));

export default router;
