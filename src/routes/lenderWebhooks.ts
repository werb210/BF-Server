// BF_SERVER_v873_LENDER_API - POST /api/lender-webhooks/:connectionId/:token (public; the lender calls it).
// Checks the address secret, then the connection's signature scheme (src/lenderConnectors/webhook.ts), then applies
// each update to the matching deal and schedules an immediate poll so offers and conditions follow. Answers 200 with
// { ok, applied } (or the Salesforce Ack for Outbound Messages), 401 when the secret or signature is wrong, 404 for an
// unknown or switched-off connection.
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import type { Q } from "../settingsPack/common.js";
import { connectorFor } from "../lenderConnectors/registry.js";
import { loadConnectionById, openSecrets } from "../lenderConnectors/store.js";
import { safeEqual, verifyWebhook } from "../lenderConnectors/webhook.js";
import { applyToSubmission, findSubmissionForPush } from "../lenderConnectors/poll.js";
import { logEvent } from "../lenderConnectors/sync.js";
import { OUTBOUND_MESSAGE_ACK, outboundRecordUpdate, parseOutboundMessage } from "../lenderConnectors/connectors/salesforce.js";
import type { RemoteUpdate } from "../lenderConnectors/types.js";

const router = Router();
const limiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: rateLimitKeyFromRequest });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const xml = express.text({ type: ["text/xml", "application/xml", "application/soap+xml"], limit: "2mb" });

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

router.post("/:connectionId/:token", limiter, xml, safeHandler(async (req: any, res: any) => {
  const db = pool as unknown as Q;
  const id = String(req.params.connectionId ?? "");
  if (!UUID_RE.test(id)) return res.status(404).json({ ok: false, error: "not_found" });
  const connection = await loadConnectionById(db, id);
  if (!connection || !connection.enabled) return res.status(404).json({ ok: false, error: "not_found" });
  const secrets = openSecrets(connection.secrets_encrypted);
  if (!secrets.webhook_url_token || !safeEqual(String(req.params.token ?? ""), secrets.webhook_url_token)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const connector = connectorFor(connection.connector);
  if (!connector || connector.availability !== "available" || !connector.capabilities.webhook) return res.status(404).json({ ok: false, error: "not_found" });
  const config = connection.config ?? {};
  const wh = obj(config.webhook);

  let updates: RemoteUpdate[] = [];
  const isOutbound = (connection.connector === "salesforce" || connection.connector === "merchant_growth") && String(wh.mode ?? "") === "outbound_message";
  if (isOutbound) {
    if (typeof req.body !== "string") return res.status(400).json({ ok: false, error: "expected_soap_xml" });
    const msg = parseOutboundMessage(req.body);
    const expected = String(wh.org_id ?? "").trim();
    // Salesforce shows the 15- or 18-character org id; compare on the first 15 characters.
    if (!expected || !msg.organizationId || !safeEqual(msg.organizationId.slice(0, 15), expected.slice(0, 15))) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    updates = msg.records.map((r) => outboundRecordUpdate(config, r.fields)).filter((u): u is RemoteUpdate => u !== null);
  } else {
    const raw: Buffer = (req as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}), "utf8");
    const check = verifyWebhook({
      scheme: String(wh.signature ?? "none"), secret: secrets.webhook_secret ?? "", rawBody: raw, headers: req.headers ?? {},
      signatureHeader: String(wh.signature_header ?? "") || undefined, signaturePrefix: String(wh.signature_prefix ?? "") || undefined,
      timestampHeader: String(wh.timestamp_header ?? "") || undefined,
    });
    if (!check.ok) return res.status(401).json({ ok: false, error: "unauthorized", reason: check.reason });
    updates = connector.parseWebhook ? connector.parseWebhook(config, req.body) : [];
  }

  let applied = 0;
  for (const u of updates.slice(0, 100)) {
    const sub = await findSubmissionForPush(db, connection.lender_id, u.externalId);
    if (!sub) continue;
    await logEvent(db, { submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "webhook_received", source: "webhook", status: u.status ?? null, detail: `${sub.lender_name} sent an update.` });
    // A push about the converted record carries that record's id: keep our own deal id on the update.
    const out = await applyToSubmission(db, sub, { ...u, externalId: sub.external_id ?? u.externalId }, "webhook");
    if (out.ok) applied += 1;
    // Pull the full picture (offers, conditions) straight away when the lender also reports status by API.
    if (connector.capabilities.status && sub.external_id) {
      await db.query(`UPDATE lender_api_submissions SET next_poll_at = now() WHERE id::text = $1`, [sub.id]);
    }
  }
  if (isOutbound) {
    res.status(200).type("text/xml").send(OUTBOUND_MESSAGE_ACK);
    return;
  }
  res.json({ ok: true, received: updates.length, applied });
}));

export default router;
