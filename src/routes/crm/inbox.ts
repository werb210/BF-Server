import express from "express";
import { pool } from "../../db.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { respondOk } from "../../utils/respondOk.js";
import { getGraphForUser } from "../../modules/o365/graphClient.js";
// BF_SERVER_BLOCK_BI_ROUND5_CRM_SILO_RESOLVE_v1
import { resolveSiloFromRequest } from "../../middleware/silo.js";

const router = express.Router();

router.get("/", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });

  const mailbox = (req.query.mailbox ?? "").toString().trim();
  let path = "/me/mailFolders/Inbox/messages?$top=50&$select=id,subject,from,receivedDateTime,bodyPreview,isRead";
  if (mailbox) {
    const role = (req.user?.role ?? "").toString().toLowerCase();
    // v607: Admin role can access any shared mailbox without the
    // shared_mailbox_settings allow-list lookup. Non-admins still gated.
    if (role !== "admin") {
      const silo = resolveSiloFromRequest(req);
      const { rows } = await pool.query(
        `SELECT 1 FROM shared_mailbox_settings
         WHERE LOWER(address)=LOWER($1) AND silo = $2 AND LOWER($3) = ANY(SELECT LOWER(r) FROM unnest(allowed_roles) r)
         LIMIT 1`,
        [mailbox, silo, role],
      );
      if (!rows.length) return res.status(403).json({ error: "mailbox_not_allowed" });
    }
    path = `/users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/messages?$top=50&$select=id,subject,from,receivedDateTime,bodyPreview,isRead`;
  }
  const r = await graph.fetch(path);
  if (!r.ok) return res.status(r.status).json({ error: "graph_inbox_failed" });
  const data = await r.json();
  respondOk(res, data.value ?? []);
}));

router.get("/:messageId", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });
  const mailbox = (req.query.mailbox ?? "").toString().trim();
  const base = mailbox ? `/users/${encodeURIComponent(mailbox)}` : "/me";
  const r = await graph.fetch(`${base}/messages/${req.params.messageId}`);
  if (!r.ok) return res.status(r.status).json({ error: "graph_message_failed" });
  respondOk(res, await r.json());
}));

// BF_SERVER_BLOCK_v641_INBOX_DELETE_v1
// DELETE /api/crm/inbox/:messageId
// Soft-delete by moving to "Deleted Items" via Graph (POST /messages/:id/move
// with destinationId="deleteditems"). Reversible. Mirrors Outlook UI behavior.
router.delete("/:messageId", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });
  const mailbox = (req.query.mailbox ?? "").toString().trim();
  if (mailbox) {
    const role = (req.user?.role ?? "").toString().toLowerCase();
    if (role !== "admin") {
      const silo = resolveSiloFromRequest(req);
      const { rows } = await pool.query(
        `SELECT 1 FROM shared_mailbox_settings
         WHERE LOWER(address)=LOWER($1) AND silo = $2 AND LOWER($3) = ANY(SELECT LOWER(r) FROM unnest(allowed_roles) r)
         LIMIT 1`,
        [mailbox, silo, role],
      );
      if (!rows.length) return res.status(403).json({ error: "mailbox_not_allowed" });
    }
  }
  const base = mailbox ? `/users/${encodeURIComponent(mailbox)}` : "/me";
  const r = await graph.fetch(`${base}/messages/${encodeURIComponent(req.params.messageId)}/move`, {
    method: "POST",
    body: JSON.stringify({ destinationId: "deleteditems" }),
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => "");
    return res.status(r.status).json({ error: "graph_delete_failed", detail: errBody.slice(0, 300) });
  }
  return res.json({ success: true });
}));

export default router;
