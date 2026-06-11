import express from "express";
import { pool } from "../../db.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { respondOk } from "../../utils/respondOk.js";
import { getGraphForUser } from "../../modules/o365/graphClient.js";
// BF_SERVER_BLOCK_BI_ROUND5_CRM_SILO_RESOLVE_v1
import { resolveSiloFromRequest } from "../../middleware/silo.js";
import { randomUUID } from "node:crypto"; // BF_SERVER_BLOCK_v797_EMAIL_OPEN_TRACKING

const router = express.Router({ mergeParams: true });

router.get("/", safeHandler(async (req: any, res: any) => {
  const { contactId, companyId } = resolveScope(req);
  const silo = resolveSiloFromRequest(req);
  const where: string[] = ["silo = $1"]; const params: unknown[] = [silo];
  if (contactId) { params.push(contactId); where.push(`contact_id = $${params.length}`); }
  if (companyId) { params.push(companyId); where.push(`company_id = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT id, from_address, to_addresses, subject, created_at
     FROM crm_email_log WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC LIMIT 200`,
    params,
  );
  respondOk(res, rows);
}));

router.post("/", safeHandler(async (req: any, res: any) => {
  const { contactId, companyId } = resolveScope(req);
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });

  const { from, to, cc = [], bcc = [], subject = "", body_html = "" } = req.body ?? {};
  if (!from || !Array.isArray(to) || !to.length) return res.status(400).json({ error: "from + to required" });

  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected", message: "Connect Microsoft 365 in Settings → My Profile to send email." });

  const silo = resolveSiloFromRequest(req);
  const me = await graph.fetch("/me?$select=mail,userPrincipalName");
  const meJson = await me.json();
  const userEmail = (meJson.mail ?? meJson.userPrincipalName ?? "").toLowerCase();
  const fromLower = String(from).toLowerCase();

  let endpoint = "/me/sendMail";
  if (fromLower !== userEmail) {
    const role = (req.user?.role ?? "").toString();
    const { rows } = await pool.query(
      `SELECT 1 FROM shared_mailbox_settings
       WHERE LOWER(address) = $1 AND silo = $2 AND $3 = ANY(allowed_roles) LIMIT 1`,
      [fromLower, silo, role],
    );
    if (!rows.length) return res.status(403).json({ error: "from_not_allowed" });
    endpoint = `/users/${encodeURIComponent(from)}/sendMail`;
  }

  // BF_SERVER_BLOCK_v797_EMAIL_OPEN_TRACKING — embed a 1x1 tracking pixel so an open
  // is detected reliably (not just via opt-in "Read:" receipts). The token ties the open
  // back to this crm_email_log row; the follow-up worker alerts the sender if unopened.
  // BF_SERVER_BLOCK_v824_PER_ACCOUNT_SIGNATURE — pick the right signature:
  // sending AS a shared mailbox -> that mailbox's signature_html; sending as
  // yourself -> your own user_settings signature. Empty if none set.
  let signatureHtml = "";
  try {
    if (fromLower !== userEmail) {
      const sigRow = await pool.query<{ signature_html: string | null }>(
        `SELECT signature_html FROM shared_mailbox_settings WHERE LOWER(address) = $1 AND silo = $2 LIMIT 1`,
        [fromLower, silo],
      );
      signatureHtml = (sigRow.rows[0]?.signature_html ?? "").toString();
    } else {
      const sigRow = await pool.query<{ email_signature_html: string | null }>(
        `SELECT email_signature_html FROM user_settings WHERE user_id = $1 LIMIT 1`,
        [userId],
      );
      signatureHtml = (sigRow.rows[0]?.email_signature_html ?? "").toString();
    }
  } catch { signatureHtml = ""; }

  const pixelToken = randomUUID();
  const serverBase = (process.env.SERVER_PUBLIC_URL ?? process.env.PUBLIC_SERVER_URL ?? "https://server.boreal.financial").replace(/\/+$/, "");
  const signedBody = signatureHtml.trim() ? `${body_html}<br/><br/>${signatureHtml}` : body_html;
  const trackedHtml = `${signedBody}<img src="${serverBase}/api/track/email/${pixelToken}.gif" width="1" height="1" alt="" style="display:none;width:1px;height:1px;" />`;
  const graphRes = await graph.fetch(endpoint, {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "HTML", content: trackedHtml },
        toRecipients: to.map((a: string) => ({ emailAddress: { address: a } })),
        ccRecipients: cc.map((a: string) => ({ emailAddress: { address: a } })),
        bccRecipients: bcc.map((a: string) => ({ emailAddress: { address: a } })),
        from: { emailAddress: { address: from } },
      },
      saveToSentItems: true,
    }),
  });

  if (!graphRes.ok) {
    const text = await graphRes.text().catch(() => "");
    return res.status(502).json({ error: "graph_send_failed", detail: text.slice(0, 500) });
  }

  const { rows } = await pool.query(
    `INSERT INTO crm_email_log
       (from_address,to_addresses,cc_addresses,bcc_addresses,subject,body_html,
        owner_id,contact_id,company_id,silo,pixel_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [from, to, cc, bcc, subject, body_html, userId, contactId, companyId, silo, pixelToken],
  );
  res.status(201).json({ ok: true, data: rows[0] });
}));

function resolveScope(req: any): { contactId: string | null; companyId: string | null } {
  const isContact = req.baseUrl?.includes("/contacts/");
  const id = req.params.id;
  return isContact ? { contactId: id, companyId: req.body?.companyId ?? null }
    : { companyId: id, contactId: req.body?.contactId ?? null };
}

export default router;
