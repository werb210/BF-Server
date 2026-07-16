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

// BF_SERVER_TEAMS_MEETING_SCHEDULE_v1 - book a Teams meeting against a CRM
// contact. The signed-in staff member is the ORGANIZER: we create the event on
// their calendar with their delegated token (the same o365 connection the
// mailbox uses, which already carries Calendars.ReadWrite). That matters for
// two reasons: the Teams transcript API only exposes artifacts for meetings
// tied to a real calendar event, and the tenant's application access policy is
// granted per-organizer. We persist the Graph event id + the onlineMeeting id
// against contact_id + silo so the transcript/recording poller knows whose
// timeline to write to when the artifacts land.
router.post("/meetings/schedule", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });

  const body = (req.body ?? {}) as Record<string, unknown>;
  const contactId = typeof body.contact_id === "string" ? body.contact_id : null;
  const subject = typeof body.subject === "string" && body.subject.trim() ? body.subject.trim() : "Boreal meeting";
  const startIso = typeof body.start === "string" ? body.start : null;
  const endIso = typeof body.end === "string" ? body.end : null;
  const attendees = Array.isArray(body.attendees)
    ? (body.attendees as unknown[]).map((a) => String(a)).filter((a) => a.includes("@"))
    : [];

  if (!contactId) return res.status(400).json({ error: "contact_id_required" });
  if (!startIso || !endIso) return res.status(400).json({ error: "start_and_end_required" });

  const silo = resolveSiloFromRequest(req);

  // The event MUST be a real calendar event with isOnlineMeeting=true. A bare
  // onlineMeeting object is not addressable by the transcript API.
  const eventBody = {
    subject,
    start: { dateTime: startIso, timeZone: "UTC" },
    end: { dateTime: endIso, timeZone: "UTC" },
    isOnlineMeeting: true,
    onlineMeetingProvider: "teamsForBusiness",
    attendees: attendees.map((address) => ({
      emailAddress: { address },
      type: "required",
    })),
  };

  const created = await graph.fetch("/me/events", {
    method: "POST",
    body: JSON.stringify(eventBody),
  });
  if (!created.ok) {
    return res.status(502).json({
      error: "graph_event_create_failed",
      detail: (await created.text()).slice(0, 500),
    });
  }
  const ev: any = await created.json().catch(() => ({}));

  // Graph returns the join url on the event; the onlineMeeting id is derived
  // from it and is what the transcript endpoints key on.
  const joinUrl: string | null = ev?.onlineMeeting?.joinUrl ?? null;
  const graphEventId: string | null = ev?.id ?? null;

  const me = await graph.fetch("/me?$select=userPrincipalName");
  const meJson: any = me.ok ? await me.json().catch(() => ({})) : {};
  const organizerUpn: string | null = meJson?.userPrincipalName ?? null;

  const row = await pool.query(
    `INSERT INTO teams_meetings
       (silo, contact_id, organizer_user_id, organizer_upn, subject,
        graph_event_id, join_url, scheduled_at, scheduled_end_at, status)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, 'scheduled')
     ON CONFLICT (graph_event_id) WHERE graph_event_id IS NOT NULL DO UPDATE
       SET subject = EXCLUDED.subject,
           scheduled_at = EXCLUDED.scheduled_at,
           scheduled_end_at = EXCLUDED.scheduled_end_at,
           updated_at = now()
     RETURNING id::text AS id`,
    [silo, contactId, userId, organizerUpn, subject, graphEventId, joinUrl, startIso, endIso],
  );

  res.json({
    success: true,
    data: {
      id: row.rows[0]?.id ?? null,
      graph_event_id: graphEventId,
      join_url: joinUrl,
      organizer: organizerUpn,
    },
  });
}));

// List the Teams meetings booked against a contact (for the CRM record panel).
router.get("/meetings/by-contact/:contactId", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(
    `SELECT id::text AS id, subject, join_url, scheduled_at, scheduled_end_at,
            recording_url, transcript_fetched_at, maya_summary, status
       FROM teams_meetings
      WHERE contact_id = $1::uuid AND silo = $2
      ORDER BY scheduled_at DESC NULLS LAST
      LIMIT 100`,
    [req.params.contactId, silo],
  );
  res.json({ success: true, data: r.rows });
}));

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

  // BF_SERVER_SENDMAIL_ITEMNOTFOUND_RETRY_v1
  // A mailbox converted from a licensed user mailbox to a shared mailbox can end
  // up with a Sent Items folder Graph cannot write to, even though the mailbox is
  // otherwise healthy and sends fine from OWA. Graph then fails the whole
  // sendMail with ErrorItemNotFound ("The specified object was not found in the
  // store.") because of the saveToSentItems copy, not the delivery itself.
  // Retry once without the Sent Items copy so the mail still goes out.
  let send = await graph.fetch(endpoint, {
    method: "POST",
    body: JSON.stringify({ message, saveToSentItems: true }),
  });

  if (!send.ok) {
    const firstDetail = (await send.text()).slice(0, 500);
    if (firstDetail.includes("ErrorItemNotFound")) {
      send = await graph.fetch(endpoint, {
        method: "POST",
        body: JSON.stringify({ message, saveToSentItems: false }),
      });
      if (!send.ok) {
        return res.status(502).json({ error: "graph_send_failed", detail: (await send.text()).slice(0, 500) });
      }
    } else {
      return res.status(502).json({ error: "graph_send_failed", detail: firstDetail });
    }
  }

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
          `SELECT id, lower(email) AS email FROM contacts WHERE silo = $1 AND lower(email) = ANY($2::text[])`,
          [_silo, _recips],
        );
        const _matched = new Set(_m.rows.map((r: any) => String(r.email)));
        for (const _row of _m.rows) {
          await logEmail(_row.id, null, _silo);
        }
        // BF_SERVER_EMAIL_AUTOCREATE_CONTACT_v1 - emailing someone from the
        // Inbox who has no CRM contact previously logged NOTHING and created
        // NOTHING, so the exchange was invisible in CRM. Create a lead contact
        // for each unknown external recipient, then log the email to it.
        // Internal boreal addresses are skipped.
        for (const _addr of _recips) {
          if (_matched.has(_addr)) continue;
          if (/@boreal\.(financial|insure)$/i.test(_addr)) continue;
          const _local = String(_addr.split("@")[0] ?? _addr);
          const _guessName =
            _local.replace(/[._-]+/g, " ").replace(/[0-9]+/g, " ").trim().replace(/\s+/g, " ")
              .split(" ").map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ").trim() || _addr;
          try {
            const _created = await pool.query(
              `INSERT INTO contacts (id, company_id, name, email, phone, status, silo, lead_status, tags, lifecycle_stage, created_at, updated_at)
               VALUES (gen_random_uuid(), NULL, $1, $2, NULL, 'active', $3, 'New', ARRAY['email']::text[], 'lead', now(), now())
               RETURNING id`,
              [_guessName, _addr, _silo],
            );
            if (_created.rows[0]?.id) await logEmail(_created.rows[0].id, null, _silo);
          } catch (_ce) { console.warn("[crm_email_log] auto-create contact failed", _addr, _ce); }
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

// BF_SERVER_BLOCK_v_MAIL_CATEGORIES_v1 - Outlook category (color-label) support.
// Setting a message's categories needs Mail.ReadWrite (already granted). Listing
// the mailbox master categories needs MailboxSettings.Read; when that scope is not
// present we fall back to the standard Outlook preset colours so tagging still works.
const PRESET_MAIL_CATEGORIES = [
  { displayName: "Red category", color: "preset0" },
  { displayName: "Orange category", color: "preset1" },
  { displayName: "Yellow category", color: "preset3" },
  { displayName: "Green category", color: "preset4" },
  { displayName: "Blue category", color: "preset7" },
  { displayName: "Purple category", color: "preset9" },
];

router.get("/mail/categories", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });
  const mb = typeof req.query.mailbox === "string" && req.query.mailbox
    ? `/users/${encodeURIComponent(req.query.mailbox)}` : "/me";
  try {
    const r = await graph.fetch(`${mb}/outlook/masterCategories`);
    if (r.ok) {
      const j = await r.json();
      const cats = (j.value ?? []).map((c: any) => ({ displayName: c.displayName, color: c.color }));
      return res.json({ categories: cats.length ? cats : PRESET_MAIL_CATEGORIES, source: "graph" });
    }
  } catch { /* fall through to presets */ }
  res.json({ categories: PRESET_MAIL_CATEGORIES, source: "preset" });
}));

router.patch("/mail/messages/:id/categories", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });
  const cats: string[] = Array.isArray(req.body?.categories)
    ? req.body.categories.filter((c: any) => typeof c === "string").slice(0, 25) : [];
  const mb = typeof req.body?.mailbox === "string" && req.body.mailbox
    ? `/users/${encodeURIComponent(req.body.mailbox)}` : "/me";
  const r = await graph.fetch(`${mb}/messages/${encodeURIComponent(req.params.id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ categories: cats }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 500);
    if (r.status === 401 || r.status === 403) return res.status(412).json({ error: "o365_insufficient_scope", detail });
    return res.status(502).json({ error: "graph_set_categories_failed", detail });
  }
  res.json({ ok: true, categories: cats });
}));

export default router;
