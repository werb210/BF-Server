import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { getGraphForUser } from "../modules/o365/graphClient.js";
import { getStorage } from "../lib/storage/index.js"; // v693
import { resolveSiloFromRequest } from "../middleware/silo.js";

const router = Router();
router.use(requireAuth);

router.post("/mail/send", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });

  // v634: accept BOTH shapes — flat {to[], cc[], bcc[], subject, body_html}
  // AND Microsoft Graph {message:{subject, body:{contentType,content}, toRecipients:[{emailAddress:{address}}]}}
  let raw = req.body ?? {};
  if (raw?.message && Array.isArray(raw.message?.toRecipients)) {
    const m = raw.message;
    const pick = (xs: any[]) => (xs ?? []).map((x: any) => x?.emailAddress?.address).filter(Boolean);
    raw = {
      from: m.from?.emailAddress?.address ?? raw.from,
      to: pick(m.toRecipients),
      cc: pick(m.ccRecipients),
      bcc: pick(m.bccRecipients),
      subject: m.subject ?? "",
      body_html: m.body?.contentType === "HTML" ? (m.body?.content ?? "") : (m.body?.content ?? ""),
    };
  }
  const { from, to = [], cc = [], bcc = [], subject = "", body_html = "", attachments = [], collateralIds = [] } = raw;
  if (!Array.isArray(to) || !to.length) return res.status(400).json({ error: "to required" });

  // v635_signature + v663 fix: only stamp the individual's personal signature
  // on a personal send. Never apply it to a shared/team mailbox send
  // (submissions@, info@). Signature is applied below, after the from-address
  // is resolved.
  let bodyWithSig = body_html ?? "";
  let sendingAsSelf = true;

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
      const silo = resolveSiloFromRequest(req);
      const { rows } = await pool.query(
        `SELECT 1 FROM shared_mailbox_settings
         WHERE LOWER(address)=LOWER($1) AND silo = $2 AND $3 = ANY(allowed_roles) LIMIT 1`,
        [fromLower, silo, role],
      );
      if (!rows.length) return res.status(403).json({ error: "from_not_allowed" });
      endpoint = `/users/${encodeURIComponent(from)}/sendMail`;
      sendingAsSelf = false;
    }
  }

  if (sendingAsSelf) {
    try {
      const sigRes = await pool.query<{ email_signature_html: string | null }>(
        `SELECT email_signature_html FROM user_settings WHERE user_id = $1 LIMIT 1`,
        [userId]
      );
      const sig = sigRes.rows[0]?.email_signature_html;
      if (sig && typeof sig === "string" && sig.trim()) {
        bodyWithSig = `${bodyWithSig}<br/><br/>${sig}`;
      }
    } catch { /* user_settings may be missing — non-fatal */ }
  }

  // BF_SERVER_BLOCK_v645_INBOX_AND_SCREENSHOT_v1 — attachments passthrough.
  // Client sends [{ name, contentType, contentBytes }] where contentBytes is
  // raw base64 (no data: prefix). Graph wants @odata.type=fileAttachment.
  // Limited to ~3MB per attachment via Graph's inline-send limit; larger
  // files would need uploadSession (out of scope V1).
  const graphAttachments = (Array.isArray(attachments) ? attachments : [])
    .filter((a: any) => a && typeof a.name === "string" && typeof a.contentBytes === "string")
    .slice(0, 10)
    .map((a: any) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.name,
      contentType: a.contentType || "application/octet-stream",
      contentBytes: a.contentBytes,
    }));

  // v693: attach collateral-library PDFs by id (server-fetched from blob storage).
  const collateralAttachments: any[] = [];
  if (Array.isArray(collateralIds) && collateralIds.length) {
    try {
      const silo = resolveSiloFromRequest(req);
      const store = getStorage();
      const cr = await pool.query(
        `SELECT id, name, content_type, blob_name FROM collateral_assets WHERE id = ANY($1::uuid[]) AND silo = $2`,
        [collateralIds.map(String).slice(0, 10), silo]
      );
      for (const row of cr.rows) {
        const obj = await store.get(row.blob_name);
        if (!obj) continue;
        collateralAttachments.push({ "@odata.type": "#microsoft.graph.fileAttachment", name: row.name, contentType: row.content_type || "application/pdf", contentBytes: obj.buffer.toString("base64") });
      }
    } catch { /* collateral fetch is best-effort — never block the send */ }
  }
  const allAttachments = [...graphAttachments, ...collateralAttachments];

  const send = await graph.fetch(endpoint, {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "HTML", content: bodyWithSig },
        toRecipients: to.map((a: string) => ({ emailAddress: { address: a } })),
        ccRecipients: cc.map((a: string) => ({ emailAddress: { address: a } })),
        bccRecipients: bcc.map((a: string) => ({ emailAddress: { address: a } })),
        ...(allAttachments.length ? { attachments: allAttachments } : {}),
        ...(from ? { from: { emailAddress: { address: from } } } : {}),
      },
      saveToSentItems: true,
    }),
  });

  if (!send.ok) return res.status(502).json({ error: "graph_send_failed", detail: (await send.text()).slice(0, 500) });
  res.json({ ok: true });
}));

// v635_signature_route: GET/PUT for the saved HTML signature.
router.get("/me/signature", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const r = await pool.query<{ email_signature_html: string | null }>(
    `SELECT email_signature_html FROM user_settings WHERE user_id = $1 LIMIT 1`, [userId]
  ).catch(() => ({ rows: [] as any[] }));
  res.json({ signatureHtml: r.rows[0]?.email_signature_html ?? "" });
}));
router.put("/me/signature", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const html = String(req.body?.signatureHtml ?? "").slice(0, 20000); // cap at 20KB
  await pool.query(
    `INSERT INTO user_settings (user_id, email_signature_html, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE
       SET email_signature_html = EXCLUDED.email_signature_html, updated_at = now()`,
    [userId, html]
  );
  res.json({ ok: true });
}));

// v693: per-user booking/meeting link (used by template meeting button).
router.get("/me/booking-url", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const r = await pool.query<{ booking_url: string | null }>(
    `SELECT booking_url FROM user_settings WHERE user_id = $1 LIMIT 1`, [userId]
  ).catch(() => ({ rows: [] as any[] }));
  res.json({ bookingUrl: r.rows[0]?.booking_url ?? "" });
}));
router.put("/me/booking-url", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const url = String(req.body?.bookingUrl ?? "").slice(0, 1000);
  await pool.query(
    `INSERT INTO user_settings (user_id, booking_url, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET booking_url = EXCLUDED.booking_url, updated_at = now()`,
    [userId, url]
  );
  res.json({ ok: true, bookingUrl: url });
}));

export default router;
