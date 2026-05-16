import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { getGraphForUser } from "../modules/o365/graphClient.js";

const router = Router();
router.use(requireAuth);

router.post("/mail/send", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });

  const { from, to = [], cc = [], bcc = [], subject = "", body_html = "" } = req.body ?? {};
  if (!Array.isArray(to) || !to.length) return res.status(400).json({ error: "to required" });

  let endpoint = "/me/sendMail";
  if (from) {
    const me = await graph.fetch("/me?$select=mail,userPrincipalName");
    const meJson = await me.json();
    const userEmail = (meJson.mail ?? meJson.userPrincipalName ?? "").toLowerCase();
    const fromLower = String(from).toLowerCase();
    if (fromLower !== userEmail) {
      const role = (req.user?.role ?? "").toString();
      // BF_SERVER_BLOCK_BI_ROUND5_B_v1 -- silo source moved to
      // resolveSiloFromRequest so a BF-primary admin / multi-silo
      // staff temporarily in the BI silo can still send-as the
      // BI-scoped shared mailboxes seeded under silo='BI' in
      // shared_mailbox_settings (info@/submissions@ for BI).
      const { resolveSiloFromRequest } = await import("../middleware/silo.js");
      const silo = resolveSiloFromRequest(req);
      const { rows } = await pool.query(
        `SELECT 1 FROM shared_mailbox_settings
         WHERE LOWER(address)=LOWER($1) AND silo = $2 AND $3 = ANY(allowed_roles) LIMIT 1`,
        [fromLower, silo, role],
      );
      if (!rows.length) return res.status(403).json({ error: "from_not_allowed" });
      endpoint = `/users/${encodeURIComponent(from)}/sendMail`;
    }
  }

  const send = await graph.fetch(endpoint, {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "HTML", content: body_html },
        toRecipients: to.map((a: string) => ({ emailAddress: { address: a } })),
        ccRecipients: cc.map((a: string) => ({ emailAddress: { address: a } })),
        bccRecipients: bcc.map((a: string) => ({ emailAddress: { address: a } })),
        ...(from ? { from: { emailAddress: { address: from } } } : {}),
      },
      saveToSentItems: true,
    }),
  });

  if (!send.ok) return res.status(502).json({ error: "graph_send_failed", detail: (await send.text()).slice(0, 500) });
  res.json({ ok: true });
}));

router.post("/todo/tasks", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  const graph = userId ? await getGraphForUser(pool, userId) : null;
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });

  const listResp = await graph.fetch("/me/todo/lists");
  const lists = await listResp.json();
  const list = (lists.value ?? []).find((l: any) => l.wellknownListName === "defaultList") ?? lists.value?.[0];
  if (!list?.id) return res.status(502).json({ error: "default_list_not_found" });

  const create = await graph.fetch(`/me/todo/lists/${list.id}/tasks`, {
    method: "POST",
    body: JSON.stringify(req.body ?? {}),
  });
  if (!create.ok) return res.status(502).json({ error: "graph_todo_failed" });
  res.json({ ok: true, data: await create.json() });
}));

router.post("/calendar/events", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  const graph = userId ? await getGraphForUser(pool, userId) : null;
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });

  const create = await graph.fetch("/me/events", {
    method: "POST",
    body: JSON.stringify(req.body ?? {}),
  });
  if (!create.ok) return res.status(502).json({ error: "graph_calendar_failed" });
  res.json({ ok: true, data: await create.json() });
}));

router.get("/inbox", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  const graph = userId ? await getGraphForUser(pool, userId) : null;
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });

  const top = Number(req.query.top ?? 50) || 50;
  const r = await graph.fetch(`/me/mailFolders/Inbox/messages?$top=${Math.min(top, 100)}&$select=id,subject,from,receivedDateTime,bodyPreview,isRead`);
  if (!r.ok) return res.status(502).json({ error: "graph_inbox_failed" });
  const data = await r.json();
  res.json({ ok: true, data: data.value ?? [] });
}));

export default router;
