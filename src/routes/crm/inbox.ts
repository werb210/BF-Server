import { lookup } from "node:dns/promises";
import * as net from "node:net";
import express from "express";
import { pool } from "../../db.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { respondOk } from "../../utils/respondOk.js";
import { getGraphForUser, type GraphClient } from "../../modules/o365/graphClient.js";
import { resolveSiloFromRequest } from "../../middleware/silo.js";
import { fileInboundAttachments } from "../../services/contactDocuments.js"; // BF_SERVER_INBOX_FILE_TO_CRM_v1

// BF_SERVER_BLOCK_BI_ROUND5_CRM_SILO_RESOLVE_v1

// BF_SERVER_BLOCK_v747_INBOX_ALL_IMAGES
// Resolve every image in an email body so it renders under the strict portal CSP
// (img-src 'self' data: blob:). cid: -> inline-attachment data: URI; remote http(s)
// -> fetched server-side and inlined as data: URI (so the recipient browser never
// loads the sender's tracking pixel). Best-effort; never blocks the message view.
const MAX_INLINE_IMAGE_BYTES = 2_000_000;
const INLINE_IMAGE_TIMEOUT_MS = 5000;
const MAX_INLINE_IMAGE_REDIRECTS = 4;

function isBlockedRemoteImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".local")) return true;

  if (host.startsWith("::ffff:")) return isBlockedRemoteImageHost(host.slice("::ffff:".length));

  if (net.isIPv4(host)) {
    return /^(127\.|0\.|10\.|169\.254\.|192\.168\.)/.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  }

  if (net.isIPv6(host)) {
    return host === "::" || host === "::1" || host.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(host);
  }

  return false;
}

async function isAllowedRemoteImageUrl(rawUrl: string): Promise<boolean> {
  const u = new URL(rawUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (isBlockedRemoteImageHost(u.hostname)) return false;

  const records = await lookup(u.hostname, { all: true, verbatim: false });
  return records.length > 0 && records.every((record) => !isBlockedRemoteImageHost(record.address));
}

async function fetchImageAsDataUri(rawUrl: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), INLINE_IMAGE_TIMEOUT_MS);
  try {
    let currentUrl = rawUrl;
    for (let redirects = 0; redirects <= MAX_INLINE_IMAGE_REDIRECTS; redirects += 1) {
      if (!(await isAllowedRemoteImageUrl(currentUrl))) return null;
      const r = await fetch(currentUrl, { signal: ctrl.signal, redirect: "manual" });

      if (r.status >= 300 && r.status < 400) {
        const location = r.headers.get("location");
        if (!location) return null;
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!r.ok) return null;
      const ctype = (r.headers.get("content-type") || "").split(";")[0].trim();
      if (!ctype.startsWith("image/")) return null;

      const contentLength = Number(r.headers.get("content-length") || "0");
      if (contentLength > MAX_INLINE_IMAGE_BYTES) return null;

      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_INLINE_IMAGE_BYTES) return null;
      return `data:${ctype};base64,${buf.toString("base64")}`;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function inlineEmailImages(graph: GraphClient, base: string, messageId: string, message: any): Promise<void> {
  try {
    const body = message?.body;
    if (!body || typeof body.content !== "string") return;
    let html: string = body.content;

    if (html.includes("cid:")) {
      // BF_SERVER_INBOX_CID_HTMLDRIVEN_v1 - drive off the cid: refs the HTML
      // actually needs, matching an attachment by contentId OR name (forwarded
      // mail often has a contentId/name mismatch the old contentId-only match
      // skipped, leaving broken cid: images blocked by CSP).
      const cidRefs = new Set<string>();
      const cidRe = /cid:([^"'\\s)>]+)/gi;
      let cm: RegExpExecArray | null;
      while ((cm = cidRe.exec(html)) !== null) cidRefs.add(cm[1]);

      const ar = await graph.fetch(
        `${base}/messages/${encodeURIComponent(messageId)}/attachments`
          + `?$select=id,name,contentType,contentId,isInline`,
      );
      const atts: any[] = ar.ok ? (((await ar.json()) as any).value ?? []) : [];
      const norm = (v: unknown) => String(v ?? "").replace(/^<|>$/g, "");
      const unresolved: string[] = [];
      for (const ref of cidRefs) {
        const head = ref.split("@")[0];
        const att = atts.find((a) => {
          const cid = norm(a?.contentId);
          return cid === ref || a?.name === ref || cid === head || a?.name === head;
        });
        if (!att) { unresolved.push(ref); continue; }
        const ctype: string = att.contentType || "image/png";
        let bytes: string | undefined = att.contentBytes;
        if (!bytes && att.id) {
          const one = await graph.fetch(
            `${base}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(att.id)}`,
          );
          if (one.ok) bytes = ((await one.json()) as any)?.contentBytes;
        }
        if (bytes) {
          html = html.split(`cid:${ref}`).join(`data:${ctype};base64,${bytes}`);
        } else {
          unresolved.push(ref);
        }
      }
      if (unresolved.length > 0) {
        console.warn("[inbox.inlineImages] unresolved cid refs", {
          messageId,
          unresolved,
          attachmentContentIds: atts.map((a) => norm(a?.contentId)),
          attachmentNames: atts.map((a) => a?.name),
        });
      }
    }

    const urls = new Set<string>();
    const re = /<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) urls.add(m[1]);
    for (const url of urls) {
      const dataUri = await fetchImageAsDataUri(url);
      if (dataUri) html = html.split(url).join(dataUri);
    }

    message.body.content = html;
  } catch { /* best-effort: never block the message view */ }
}

const router = express.Router();

router.get("/", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });

  const mailbox = (req.query.mailbox ?? "").toString().trim();
  const folderRaw = (req.query.folder ?? "inbox").toString().toLowerCase().trim();
  const folder = ["inbox", "sent", "all"].includes(folderRaw) ? folderRaw : "inbox";
  // BF_SERVER_INBOX_FOLDERID_v1 - optional explicit Outlook folder id (from /folders/list)
  // to browse any folder; falls back to the inbox/sent/all shortcuts when absent.
  const folderId = (req.query.folderId ?? "").toString().trim();

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
  const select = "$select=id,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,isRead,flag,conversationId"; // BF_SERVER_BLOCK_v833_INBOX_SEARCH_THREAD_FOLDERS
  // BF_SERVER_BLOCK_v823_INBOX_READSTATUS_AND_SORT — optional sort (default desc).
  const sortDir = String((req.query.sort ?? "")).toLowerCase() === "asc" ? "asc" : "desc";
  const orderby = `$orderby=receivedDateTime ${sortDir}`;

  async function fetchFolder(client: GraphClient, folderId: string): Promise<any[]> {
    // BF_SERVER_BLOCK_v833_INBOX_SEARCH_THREAD_FOLDERS — $search (relevance order,
    // no $orderby allowed by Graph) when a query is present; else normal sorted list.
    const q = String(req.query.q ?? "").trim();
    const url = q
      ? `${base}/mailFolders/${encodeURIComponent(folderId)}/messages?$top=50&${select}&$search="${encodeURIComponent(q)}"`
      : `${base}/mailFolders/${encodeURIComponent(folderId)}/messages?$top=50&${select}&${orderby}`;
    const r = await client.fetch(url, q ? { headers: { ConsistencyLevel: "eventual" } } : undefined);
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data?.value) ? data.value : [];
  }

  let messages: any[] = [];
  if (folderId) {
    messages = await fetchFolder(graph, folderId);
  } else if (folder === "inbox") {
    messages = await fetchFolder(graph, "Inbox");
  } else if (folder === "sent") {
    messages = await fetchFolder(graph, "SentItems");
    messages = messages.map((m) => ({ ...m, _folder: "sent" }));
  } else {
    const [inbox, sent] = await Promise.all([
      fetchFolder(graph, "Inbox"),
      fetchFolder(graph, "SentItems"),
    ]);
    messages = [
      ...inbox.map((m) => ({ ...m, _folder: "inbox" })),
      ...sent.map((m) => ({ ...m, _folder: "sent" })),
    ].sort((a, b) => {
      const ta = new Date(a.receivedDateTime ?? a.sentDateTime ?? 0).getTime();
      const tb = new Date(b.receivedDateTime ?? b.sentDateTime ?? 0).getTime();
      return sortDir === "asc" ? ta - tb : tb - ta;
    });
  }

  respondOk(res, messages);
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
  // BF_SERVER_BLOCK_v720 — opening an email marks it read in Graph so the
  // Communications "Inbox" unread badge clears (fire-and-forget; idempotent).
  void graph.fetch(`${base}/messages/${encodeURIComponent(req.params.messageId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isRead: true }),
  }).catch(() => undefined);
  const message: any = await r.json();
  await inlineEmailImages(graph, base, req.params.messageId, message); // BF_SERVER_BLOCK_v747
  respondOk(res, message);
}));

// BF_SERVER_INBOX_ATTACHMENTS_v1 - list real (non-inline) file attachments for a message
// so the portal can show/download them. Inline images are already embedded in the body.
router.get("/:messageId/attachments", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });
  const mailbox = (req.query.mailbox ?? "").toString().trim();
  const base = mailbox ? `/users/${encodeURIComponent(mailbox)}` : "/me";
  const r = await graph.fetch(
    `${base}/messages/${encodeURIComponent(req.params.messageId)}/attachments`
      + `?$select=id,name,contentType,size,isInline`,
  );
  if (!r.ok) return res.status(r.status).json({ error: "graph_attachments_failed" });
  const data: any = await r.json();
  const list = (Array.isArray(data?.value) ? data.value : [])
    .filter((a: any) => a && a.isInline !== true)
    .map((a: any) => ({ id: a.id, name: a.name ?? "attachment", contentType: a.contentType ?? "application/octet-stream", size: a.size ?? 0 }));
  respondOk(res, list);
}));

// BF_SERVER_INBOX_ATTACHMENTS_v1 - download one attachment as base64 JSON so the JSON api
// client can decode it to a Blob. Graph fileAttachment carries contentBytes (base64).
router.get("/:messageId/attachments/:attachmentId", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });
  const mailbox = (req.query.mailbox ?? "").toString().trim();
  const base = mailbox ? `/users/${encodeURIComponent(mailbox)}` : "/me";
  const r = await graph.fetch(
    `${base}/messages/${encodeURIComponent(req.params.messageId)}/attachments/${encodeURIComponent(req.params.attachmentId)}`,
  );
  if (!r.ok) return res.status(r.status).json({ error: "graph_attachment_failed" });
  const att: any = await r.json();
  const contentBytes: string | undefined = att?.contentBytes;
  if (!contentBytes) return res.status(415).json({ error: "not_a_file_attachment" });
  respondOk(res, {
    name: att?.name ?? "attachment",
    contentType: att?.contentType ?? "application/octet-stream",
    size: att?.size ?? 0,
    contentBytes,
  });
}));

// BF_SERVER_BLOCK_v832_INBOX_FLAG
// PATCH /api/crm/inbox/:messageId/flag  body: { flagged: boolean }
router.patch("/:messageId/flag", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });
  const flagged = req.body?.flagged !== false; // default true
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
  const r = await graph.fetch(`${base}/messages/${encodeURIComponent(req.params.messageId)}`, {
    method: "PATCH",
    body: JSON.stringify({ flag: { flagStatus: flagged ? "flagged" : "notFlagged" } }),
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => "");
    return res.status(r.status).json({ error: "graph_flag_failed", detail: errBody.slice(0, 300) });
  }
  return res.json({ success: true, flagged });
}));

// BF_SERVER_BLOCK_v833_INBOX_SEARCH_THREAD_FOLDERS
// GET /api/crm/inbox/folders/list — list the mailbox's Outlook folders (id + name + unread).
router.get("/folders/list", safeHandler(async (req: any, res: any) => {
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
  const r = await graph.fetch(`${base}/mailFolders?$top=60&$select=id,displayName,unreadItemCount,totalItemCount`);
  if (!r.ok) return res.json({ success: true, data: [] });
  const data = await r.json();
  const folders = (Array.isArray(data?.value) ? data.value : []).map((f: any) => ({
    id: f.id, name: f.displayName, unread: f.unreadItemCount ?? 0, total: f.totalItemCount ?? 0,
  }));
  respondOk(res, folders);
}));

// BF_SERVER_BLOCK_v823_INBOX_READSTATUS_AND_SORT
// PATCH /api/crm/inbox/:messageId/read  body: { isRead: boolean }
router.patch("/:messageId/read", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });
  const isRead = req.body?.isRead !== false; // default true
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
  const r = await graph.fetch(`${base}/messages/${encodeURIComponent(req.params.messageId)}`, {
    method: "PATCH",
    body: JSON.stringify({ isRead }),
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => "");
    return res.status(r.status).json({ error: "graph_read_failed", detail: errBody.slice(0, 300) });
  }
  return res.json({ success: true, isRead });
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

// BF_SERVER_INBOX_MOVE_v1 - POST /api/crm/inbox/:messageId/move  body: { destinationId }
// Move a message to any Outlook folder (id from /folders/list, or well-known names like
// "inbox"/"archive"/"junkemail"/"deleteditems"). Same auth + shared-mailbox checks as
// delete; delete is just this with destinationId fixed to "deleteditems".
router.post("/:messageId/move", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  let destinationId = String(req.body?.destinationId ?? "").trim();
  const destinationName = String(req.body?.destinationName ?? "").trim();
  if (!destinationId && !destinationName) return res.status(400).json({ error: "destination_required" });
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
  // BF_SERVER_INBOX_MOVE_BYNAME_v1 - a folder id pre-fetched from another mailbox context is
  // invalid in the message's actual mailbox (that is why "Move to" failed in All-Mailboxes view).
  // Resolve the destination by name inside THIS mailbox: well-known names map directly, custom
  // folders are looked up by displayName so the id is always correct for the target mailbox.
  if (destinationName) {
    const wk: Record<string, string> = {
      "inbox": "inbox", "archive": "archive", "drafts": "drafts", "outbox": "outbox",
      "sent": "sentitems", "sent items": "sentitems",
      "deleted": "deleteditems", "deleted items": "deleteditems",
      "junk": "junkemail", "junk email": "junkemail", "clutter": "clutter",
    };
    const known = wk[destinationName.toLowerCase()];
    if (known) {
      destinationId = known;
    } else {
      const fr = await graph.fetch(`${base}/mailFolders?$top=200&$select=id,displayName`);
      if (fr.ok) {
        const fj: any = await fr.json();
        const match = (Array.isArray(fj?.value) ? fj.value : []).find(
          (f: any) => String(f?.displayName ?? "").toLowerCase() === destinationName.toLowerCase(),
        );
        if (match?.id) destinationId = match.id;
      }
    }
    if (!destinationId) return res.status(404).json({ error: "folder_not_found", detail: destinationName });
  }
  const r = await graph.fetch(`${base}/messages/${encodeURIComponent(req.params.messageId)}/move`, {
    method: "POST",
    body: JSON.stringify({ destinationId }),
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => "");
    return res.status(r.status).json({ error: "graph_move_failed", detail: errBody.slice(0, 300) });
  }
  return res.json({ success: true });
}));

// BF_SERVER_INBOX_FILE_TO_CRM_v1 - file a message's attachments to the matching (or newly
// created) CRM contact in the request's silo. Manual trigger; the inbound poller reuses
// fileInboundAttachments. Idempotent via the contact_documents dedupe key.
router.post("/:messageId/file-to-crm", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });
  const mailbox = (req.query.mailbox ?? "").toString().trim();
  const base = mailbox ? `/users/${encodeURIComponent(mailbox)}` : "/me";
  const r = await graph.fetch(`${base}/messages/${encodeURIComponent(req.params.messageId)}?$select=id,from,hasAttachments`);
  if (!r.ok) return res.status(r.status).json({ error: "graph_message_failed" });
  const message: any = await r.json();
  const silo = resolveSiloFromRequest(req);
  const result = await fileInboundAttachments({ pool, graph, base, message, silo, ownerId: userId });
  respondOk(res, result);
}));

// BF_SERVER_INBOX_FILE_ONE_TO_CRM_v1: file a single inbound attachment (by id) to the
// sender's CRM contact. Mirrors /file-to-crm but scoped to one attachment via the service.
router.post("/:messageId/attachments/:attachmentId/file-to-crm", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return res.status(412).json({ error: "o365_not_connected" });
  const mailbox = (req.query.mailbox ?? "").toString().trim();
  const base = mailbox ? `/users/${encodeURIComponent(mailbox)}` : "/me";
  const r = await graph.fetch(`${base}/messages/${encodeURIComponent(req.params.messageId)}?$select=id,from,hasAttachments`);
  if (!r.ok) return res.status(r.status).json({ error: "graph_message_failed" });
  const message: any = await r.json();
  const silo = resolveSiloFromRequest(req);
  const result = await fileInboundAttachments({ pool, graph, base, message, silo, ownerId: userId, attachmentId: req.params.attachmentId });
  respondOk(res, result);
}));

export default router;
