import express from "express";
import { pool } from "../../db.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { respondOk } from "../../utils/respondOk.js";
import { getGraphForUser } from "../../modules/o365/graphClient.js";

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

  const me = await graph.fetch("/me?$select=mail,userPrincipalName");
  const meJson = await me.json();
  const userEmail = (meJson.mail ?? meJson.userPrincipalName ?? "").toLowerCase();
  const fromLower = String(from).toLowerCase();

  let endpoint = "/me/sendMail";
  if (fromLower !== userEmail) {
    const role = (req.user?.role ?? "").toString();
    const silo = resolveSiloFromRequest(req);
    const { rows } = await pool.query(
      `SELECT 1 FROM shared_mailbox_settings
       WHERE LOWER(address) = $1 AND silo = $2 AND $3 = ANY(allowed_roles) LIMIT 1`,
      [fromLower, silo, role],
    );
    if (!rows.length) return res.status(403).json({ error: "from_not_allowed" });
    endpoint = `/users/${encodeURIComponent(from)}/sendMail`;
  }

  const graphRes = await graph.fetch(endpoint, {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "HTML", content: body_html },
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

  const silo = resolveSiloFromRequest(req);
  const { rows } = await pool.query(
    `INSERT INTO crm_email_log
       (from_address,to_addresses,cc_addresses,bcc_addresses,subject,body_html,
        owner_id,contact_id,company_id,silo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [from, to, cc, bcc, subject, body_html, userId, contactId, companyId, silo],
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
