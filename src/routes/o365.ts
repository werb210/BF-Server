import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { bumpBiOutreachToContacted } from "../services/biOutreach.js"; // BF_SERVER_BLOCK_v344_BI_OUTREACH_AUTOADVANCE_v1
import { getGraphForUser } from "../modules/o365/graphClient.js";
import { getStorage } from "../lib/storage/index.js"; // v693
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { randomUUID } from "node:crypto";

// BF_SERVER_BLOCK_v705_INBOX_MERGE_TOKENS_v1 — shared merge-token renderer.
// Replaces {{token}} occurrences with values from ctx; unrecognized tokens -> ""
// so a literal {{first_name}} can never reach a recipient.
function renderMergeTokens(template: string, ctx: Record<string, string>): string {
  return String(template ?? "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m: string, key: string) => {
    const v = ctx[key];
    return v != null ? String(v) : "";
  });
}

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
  // BF_SERVER_BLOCK_v737_EMAIL_TIMELINE — explicit timeline target from the composer.
  const logContactId = raw?.log_contact_id ? String(raw.log_contact_id) : null;
  const logCompanyId = raw?.log_company_id ? String(raw.log_company_id) : null;
  const isReadReceiptRequested = raw?.isReadReceiptRequested === true;
  const isDeliveryReceiptRequested = raw?.isDeliveryReceiptRequested === true;
  const importance = ["low", "normal", "high"].includes(String(raw?.importance)) ? String(raw.importance) : "normal";
  const scheduleAt = raw?.scheduleAt ? String(raw.scheduleAt) : null;
  if (!Array.isArray(to) || !to.length) return res.status(400).json({ error: "to required" });

  // BF_SERVER_BLOCK_v705_INBOX_MERGE_TOKENS_v1 — substitute {{first_name}} (and
  // other tokens) BEFORE sending, so message_templates authored with merge
  // fields never reach the client raw. Recipient name is resolved from the
  // contacts table by the primary recipient email (silo-scoped). first_name
  // falls back to "there" so we never emit a bare leading comma.
  const mergeCtx: Record<string, string> = { first_name: "there", last_name: "", full_name: "", name: "", email: String(to[0] ?? "") };
  try {
    const mergeSilo = resolveSiloFromRequest(req);
    const cr = await pool.query<{ first_name: string | null; last_name: string | null; name: string | null; email: string | null }>(
      `SELECT first_name, last_name, name, email FROM contacts
        WHERE lower(email) = lower($1) AND silo = $2
        ORDER BY updated_at DESC LIMIT 1`,
      [String(to[0] ?? ""), mergeSilo]
    );
    const crow = cr.rows[0];
    if (crow) {
      const fn = (crow.first_name ?? "").trim() || (crow.name ?? "").trim().split(/\s+/)[0] || "";
      if (fn) mergeCtx.first_name = fn;
      mergeCtx.last_name = (crow.last_name ?? "").trim();
      mergeCtx.name = (crow.name ?? "").trim();
      mergeCtx.full_name = (crow.name ?? "").trim() || `${fn} ${(crow.last_name ?? "").trim()}`.trim();
      if (crow.email) mergeCtx.email = crow.email;
    }
  } catch { /* contact lookup is best-effort — fall back to "there" */ }
  const mergedSubject = renderMergeTokens(subject, mergeCtx);
  const mergedBody = renderMergeTokens(body_html ?? "", mergeCtx);

  // v635_signature + v663 fix: only stamp the individual's personal signature
  // on a personal send. Never apply it to a shared/team mailbox send
  // (submissions@, info@). Signature is applied below, after the from-address
  // is resolved.
  let bodyWithSig = mergedBody;
  let sendingAsSelf = true;
  let sharedSig: string | null = null; // BF_SERVER_BLOCK_v731 — per-mailbox team signature

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
      const { rows } = await pool.query<{ signature_html: string | null }>(
        `SELECT signature_html FROM shared_mailbox_settings
         WHERE LOWER(address)=LOWER($1) AND silo = $2 AND $3 = ANY(allowed_roles) LIMIT 1`,
        [fromLower, silo, role],
      );
      if (!rows.length) return res.status(403).json({ error: "from_not_allowed" });
      // BF_SERVER_BLOCK_v731 — each team mailbox carries its OWN signature.
      sharedSig = rows[0]?.signature_html ?? null;
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

  // BF_SERVER_BLOCK_v731 — shared/team mailbox (info@/accounting@/submissions@)
  // sends use the mailbox's OWN signature, not the sending user's.
  if (!sendingAsSelf && sharedSig && sharedSig.trim()) {
    bodyWithSig = `${bodyWithSig}<br/><br/>${sharedSig}`;
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
        `SELECT id, name, content_type, blob_name FROM collateral_assets WHERE id = ANY($1::uuid[]) AND silo IN ('BF', $2)` /* BF_SERVER_BLOCK_v847_BI_COLLATERAL_ATTACH — match the list endpoint (silo IN ('BF',silo)); send was silo=$2 only, so BF-library collateral selected from the BI composer never attached */,
        [collateralIds.map(String).slice(0, 10), silo]
      );
      for (const row of cr.rows) {
        const obj = await store.get(row.blob_name);
        if (!obj) continue;
        // BF_SERVER_BLOCK_v851 — mail clients pick the open program by filename
        // extension. Collateral names are label-only ("BI - Lender - One pager")
        // with no extension, so Outlook prompts for a program. Append the blob's
        // extension to the attachment filename so it opens as a PDF.
        const blobName = String(row.blob_name || "");
        const blobExtMatch = blobName.match(/\.([a-zA-Z0-9]{1,5})$/);
        const blobExt = blobExtMatch ? blobExtMatch[1].toLowerCase() : "pdf";
        let fname = String(row.name || "attachment").trim();
        if (!/\.[a-zA-Z0-9]{1,5}$/.test(fname)) fname = `${fname}.${blobExt}`;
        collateralAttachments.push({ "@odata.type": "#microsoft.graph.fileAttachment", name: fname, contentType: row.content_type || "application/pdf", contentBytes: obj.buffer.toString("base64") });
      }
    } catch { /* collateral fetch is best-effort — never block the send */ }
  }
  const allAttachments = [...graphAttachments, ...collateralAttachments];

  // BF_SERVER_EMAIL_PIXEL_O365_v1 - open tracking for composer-sent 1:1 email. The
  // CRM-card send path already injects a pixel + pixel_token; this main composer route
  // did not, so opens never reached the timeline. Inject the same 1x1 pixel and thread
  // pixel_token through every crm_email_log insert so the v706 "Opened:" timeline entry
  // fires for composer-sent mail too.
  const pixelToken = randomUUID();
  const _pxBase = (process.env.SERVER_PUBLIC_URL ?? process.env.PUBLIC_SERVER_URL ?? "https://server.boreal.financial").replace(/\/+$/, "");
  bodyWithSig = `${bodyWithSig}<img src="${_pxBase}/api/track/email/${pixelToken}.gif" width="1" height="1" alt="" style="display:none;width:1px;height:1px;" />`;
  const logEmail = (cid: string | null, coid: string | null, siloVal: string) =>
    pool.query(
      `INSERT INTO crm_email_log
         (from_address,to_addresses,cc_addresses,bcc_addresses,subject,body_html,
          owner_id,contact_id,company_id,silo,pixel_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [from || "", Array.isArray(to) ? to : [], Array.isArray(cc) ? cc : [], Array.isArray(bcc) ? bcc : [], mergedSubject, bodyWithSig, userId, cid, coid, siloVal, pixelToken],
    );
  const message: any = {
    subject: mergedSubject,
    body: { contentType: "HTML", content: bodyWithSig },
    importance,
    ...(isReadReceiptRequested ? { isReadReceiptRequested: true } : {}),
    ...(isDeliveryReceiptRequested ? { isDeliveryReceiptRequested: true } : {}),
    toRecipients: to.map((a: string) => ({ emailAddress: { address: a } })),
    ccRecipients: cc.map((a: string) => ({ emailAddress: { address: a } })),
    bccRecipients: bcc.map((a: string) => ({ emailAddress: { address: a } })),
    ...(allAttachments.length ? { attachments: allAttachments } : {}),
    ...(from ? { from: { emailAddress: { address: from } } } : {}),
  };

  // BF_SERVER_BLOCK_v705_SCHEDULED_SEND — park the fully-built message as a draft.
  if (scheduleAt) {
    if (!sendingAsSelf) return res.status(400).json({ error: "schedule_self_only", detail: "Scheduled send is only available from your own mailbox." });
    const when = new Date(scheduleAt);
    if (isNaN(when.getTime()) || when.getTime() <= Date.now()) return res.status(400).json({ error: "schedule_time_invalid" });
    const dr = await graph.fetch(`/me/messages`, { method: "POST", body: JSON.stringify(message) });
    if (!dr.ok) return res.status(502).json({ error: "schedule_draft_failed", detail: (await dr.text()).slice(0, 500) });
    const dj = await dr.json();
    const _scheduleSilo = resolveSiloFromRequest(req);
    await pool.query(
      `INSERT INTO scheduled_emails (user_id, draft_id, silo, subject, to_preview, send_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
      [userId, dj.id, _scheduleSilo, mergedSubject, to.join(", "), when],
    );
    try {
      if (logContactId || logCompanyId) {
        await logEmail(logContactId, logCompanyId, _scheduleSilo);
      } else {
        const _recips = Array.from(new Set([...(Array.isArray(to) ? to : []), ...(Array.isArray(cc) ? cc : [])]
          .map((a: any) => String(a || "").trim().toLowerCase()).filter(Boolean)));
        if (_recips.length) {
          const _m = await pool.query(
            `SELECT id FROM contacts WHERE silo = $1 AND lower(email) = ANY($2::text[])`,
            [_scheduleSilo, _recips],
          );
          for (const _row of _m.rows) {
            await logEmail(_row.id, null, _scheduleSilo);
          }
        }
      }
    } catch (_e) { console.error("[crm_email_log] scheduled-send logging failed:", _e); }
    return res.json({ ok: true, scheduled: true, sendAt: when.toISOString() });
  }

  const send = await graph.fetch(endpoint, {
    method: "POST",
    body: JSON.stringify({ message, saveToSentItems: true }),
  });

  if (!send.ok) return res.status(502).json({ error: "graph_send_failed", detail: (await send.text()).slice(0, 500) });

  // BF_SERVER_BLOCK_v733 — channel-level email logging. Resolve the CRM
  // contact(s) by recipient email and write crm_email_log, so a sent email
  // lands on the contact timeline regardless of where it was composed
  // (Inbox or a CRM card). No UI hint required.
  try {
    const _silo = resolveSiloFromRequest(req);
    // BF_SERVER_BLOCK_v848_EMAIL_LOG_FK_GUARD — logContactId/logCompanyId may be a
    // bi_contacts/bi id (BI card sends through this BF route). crm_email_log has a
    // FK to BF's contacts/companies, so a BI id throws crm_email_log_contact_id_fkey
    // and aborts logging. Null any id that doesn't exist in BF before inserting.
    let _safeContactId: string | null = logContactId;
    let _safeCompanyId: string | null = logCompanyId;
    if (_safeContactId) {
      const _c = await pool.query(`SELECT 1 FROM contacts WHERE id = $1 LIMIT 1`, [_safeContactId]).catch(() => ({ rows: [] as any[] }));
      if (!_c.rows[0]) _safeContactId = null;
    }
    if (_safeCompanyId) {
      const _co = await pool.query(`SELECT 1 FROM companies WHERE id = $1 LIMIT 1`, [_safeCompanyId]).catch(() => ({ rows: [] as any[] }));
      if (!_co.rows[0]) _safeCompanyId = null;
    }
    if (_safeContactId || _safeCompanyId) {
      await logEmail(_safeContactId, _safeCompanyId, _silo);
      if (logContactId) void bumpBiOutreachToContacted(logContactId); // BF_SERVER_BLOCK_v344_BI_OUTREACH_AUTOADVANCE_v1
    } else if (logContactId || logCompanyId) {
      if (logContactId) void bumpBiOutreachToContacted(logContactId);
    } else {
      const _recips = Array.from(new Set([...(Array.isArray(to) ? to : []), ...(Array.isArray(cc) ? cc : [])]
        .map((a: any) => String(a || "").trim().toLowerCase()).filter(Boolean)));
      if (_recips.length) {
        const _m = await pool.query(
          `SELECT id FROM contacts WHERE silo = $1 AND lower(email) = ANY($2::text[])`,
          [_silo, _recips],
        );
        for (const _row of _m.rows) {
          await logEmail(_row.id, null, _silo);
        }
      }
    }
  } catch (_e) { console.error("[crm_email_log] immediate-send logging failed:", _e); }

  res.json({ ok: true });
}));

// BF_SERVER_BLOCK_v703_O365_DRAFTS — real Outlook drafts via Graph /me/messages.
// Create/update, list, fetch one, delete. Merge tokens + signature are NOT
// applied here on purpose: a draft holds the raw work-in-progress, and tokens
// resolve when it is finally sent through /mail/send.
function buildDraftMessage(raw: any) {
  const norm = (xs: any) => (Array.isArray(xs) ? xs : []).map((a: string) => ({ emailAddress: { address: String(a) } }));
  const importance = ["low", "normal", "high"].includes(String(raw?.importance)) ? String(raw.importance) : "normal";
  const msg: any = {
    subject: String(raw?.subject ?? ""),
    body: { contentType: "HTML", content: String(raw?.body_html ?? "") },
    toRecipients: norm(raw?.to),
    ccRecipients: norm(raw?.cc),
    bccRecipients: norm(raw?.bcc),
    importance,
  };
  if (raw?.isReadReceiptRequested === true) msg.isReadReceiptRequested = true;
  if (raw?.isDeliveryReceiptRequested === true) msg.isDeliveryReceiptRequested = true;
  return msg;
}

router.post("/mail/draft", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });
  const draftId = req.body?.draftId ? String(req.body.draftId) : null;
  const msg = buildDraftMessage(req.body ?? {});
  const r = draftId
    ? await graph.fetch(`/me/messages/${encodeURIComponent(draftId)}`, { method: "PATCH", body: JSON.stringify(msg) })
    : await graph.fetch(`/me/messages`, { method: "POST", body: JSON.stringify(msg) });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 500);
    // eslint-disable-next-line no-console
    console.error("o365_draft_failed", { status: r.status, detail });
    if (r.status === 401 || r.status === 403) return res.status(412).json({ error: "o365_insufficient_scope", detail });
    return res.status(502).json({ error: "graph_draft_failed", detail });
  }
  const j = await r.json();
  res.json({ id: j.id ?? draftId });
}));

router.get("/mail/drafts", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });
  const r = await graph.fetch(`/me/mailFolders/drafts/messages?$top=25&$select=id,subject,bodyPreview,toRecipients,lastModifiedDateTime&$orderby=lastModifiedDateTime desc`);
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 500);
    // eslint-disable-next-line no-console
    console.error("o365_drafts_failed", { status: r.status, detail });
    if (r.status === 401 || r.status === 403) return res.status(412).json({ error: "o365_insufficient_scope", detail });
    return res.status(502).json({ error: "graph_drafts_failed", detail });
  }
  const j = await r.json();
  const items = (j.value ?? []).map((m: any) => ({
    id: m.id,
    subject: m.subject ?? "(no subject)",
    preview: m.bodyPreview ?? "",
    to: (m.toRecipients ?? []).map((x: any) => x?.emailAddress?.address).filter(Boolean),
    lastModified: m.lastModifiedDateTime ?? null,
  }));
  res.json({ items });
}));

router.get("/mail/draft/:id", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });
  const r = await graph.fetch(`/me/messages/${encodeURIComponent(req.params.id)}?$select=id,subject,body,toRecipients,ccRecipients,bccRecipients,importance`);
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 500);
    // eslint-disable-next-line no-console
    console.error("o365_draft_failed", { status: r.status, detail });
    if (r.status === 401 || r.status === 403) return res.status(412).json({ error: "o365_insufficient_scope", detail });
    return res.status(502).json({ error: "graph_draft_failed", detail });
  }
  const m = await r.json();
  const addrs = (xs: any) => (xs ?? []).map((x: any) => x?.emailAddress?.address).filter(Boolean);
  res.json({
    id: m.id,
    subject: m.subject ?? "",
    body_html: m.body?.content ?? "",
    to: addrs(m.toRecipients),
    cc: addrs(m.ccRecipients),
    bcc: addrs(m.bccRecipients),
    importance: m.importance ?? "normal",
  });
}));

router.delete("/mail/draft/:id", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });
  const r = await graph.fetch(`/me/messages/${encodeURIComponent(req.params.id)}`, { method: "DELETE" });
  if (!r.ok && r.status !== 404) return res.status(502).json({ error: "graph_draft_delete_failed", detail: (await r.text()).slice(0, 500) });
  res.json({ ok: true });
}));

// BF_SERVER_BLOCK_v705_SCHEDULED_SEND — list + cancel a user's pending scheduled sends.
router.get("/mail/scheduled", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const { rows } = await pool.query(
    `SELECT id, subject, to_preview, send_at, status FROM scheduled_emails WHERE user_id = $1 AND status = 'pending' ORDER BY send_at ASC`,
    [userId],
  );
  res.json({ items: rows });
}));

router.delete("/mail/scheduled/:id", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const cur = await pool.query(`SELECT draft_id FROM scheduled_emails WHERE id = $1 AND user_id = $2 AND status = 'pending' LIMIT 1`, [req.params.id, userId]);
  if (!cur.rows.length) return res.status(404).json({ error: "not_found" });
  await pool.query(`UPDATE scheduled_emails SET status = 'canceled' WHERE id = $1 AND user_id = $2`, [req.params.id, userId]);
  try { const graph = await getGraphForUser(pool, userId); if (graph) await graph.fetch(`/me/messages/${encodeURIComponent(cur.rows[0].draft_id)}`, { method: "DELETE" }); } catch { /* non-fatal */ }
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

// BF_SERVER_BLOCK_v731 — manage per-team-mailbox signatures (Admin only).
router.get("/shared-mailbox-signatures", safeHandler(async (req: any, res: any) => {
  const role = String(req.user?.role ?? "").toLowerCase();
  if (role !== "admin") return res.status(403).json({ error: "admin_only" });
  const silo = resolveSiloFromRequest(req);
  const { rows } = await pool.query(
    `SELECT address, display_name, signature_html
       FROM shared_mailbox_settings WHERE silo = $1 ORDER BY address ASC`,
    [silo],
  );
  res.json({ items: rows });
}));

router.put("/shared-mailbox-signatures", safeHandler(async (req: any, res: any) => {
  const role = String(req.user?.role ?? "").toLowerCase();
  if (role !== "admin") return res.status(403).json({ error: "admin_only" });
  const silo = resolveSiloFromRequest(req);
  const address = String(req.body?.address ?? "").trim();
  const signatureHtml = String(req.body?.signatureHtml ?? "").slice(0, 20000);
  if (!address) return res.status(400).json({ error: "address_required" });
  const r = await pool.query(
    `UPDATE shared_mailbox_settings SET signature_html = $3
      WHERE LOWER(address) = LOWER($1) AND silo = $2`,
    [address, silo, signatureHtml],
  );
  if (!r.rowCount) return res.status(404).json({ error: "mailbox_not_found" });
  res.json({ ok: true });
}));

export default router;
