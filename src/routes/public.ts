import { Router } from "express";
import { dbQuery } from "../db.js";
import { requireFields } from "../middleware/validate.js";
import { LeadSchema } from "../validation.js";
import { fail, ok } from "../lib/apiResponse.js";
import { wrap } from "../lib/routeWrap.js";
import { stripUndefined } from "../utils/clean.js";

const router = Router();

// BF_EMAIL_LOGO_ROUTE_v1 - public Boreal email logo (PNG), no auth, immutable cache.
const EMAIL_LOGO_PNG_B64 = "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";
router.get("/email/logo.png", (_req, res) => {
  const buf = Buffer.from(EMAIL_LOGO_PNG_B64, "base64");
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  // BF_EMAIL_LOGO_CORP_v1 - override Helmet default CORP (same-origin) so the logo
  // can be embedded cross-origin in the portal email preview iframe.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.end(buf);
});


type LeadPayload = {
  email?: string;
  phone?: string;
  productType?: string;
  businessName?: string;
  companyName?: string;
  requestedAmount?: number;
};

async function createLead(payload: LeadPayload): Promise<{ leadId?: string }> {
  const normalizedPayload = {
    ...payload,
    businessName: payload.businessName ?? payload.companyName,
  };

  const parsed = LeadSchema.safeParse(normalizedPayload ?? {});

  if (!parsed.success) {
    return {};
  }

  const data = parsed.data;
  const result = await dbQuery<{ id: string }>(
    `insert into crm_leads (email, phone, company_name, product_interest, requested_amount, source)
       values ($1, $2, $3, $4, $5, 'public_api')
       returning id`,
    [data.email, data.phone, data.businessName, data.productType, data.requestedAmount ?? null],
  );

  return stripUndefined({ leadId: result.rows[0]?.id });
}

// BF_SERVER_v68_LEAD_RES_JSON - every branch must explicitly call
// res.status(N).json(envelope). `wrap()` only catches errors; `ok`/`fail`
// only build envelope objects. Without an explicit res.json the response
// is never sent and the client hangs until timeout.
router.post(
  "/lead",
  requireFields(["companyName", "email"]),
  wrap(async (req, res) => {
      const result = await createLead(req.body);

      if (!result?.leadId) {
        return res.status(400).json(fail(res, "INVALID_INPUT"));
      }

      return res.status(200).json(ok({ leadId: result.leadId }));
    }),
);

// BF_SERVER_v66_LENDER_COUNT - GET /api/public/lender-count
// Lightweight public endpoint used by the client wizard's Step 6 to
// render "Submitted to our network of {N}+ lenders." Returns
// { count: number } where N is the count of active lenders. Tolerant
// of an environment where the `active` column might be missing.
// Calls res.json() explicitly because wrap() in this codebase does
// not inspect the handler's return value and ok() from apiResponse
// only builds the envelope object without sending it.
router.get(
  "/lender-count",
  wrap(async (_req, res) => {
    let count = 0;
    try {
      const result = await dbQuery<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM lenders WHERE COALESCE(active, true) = true`,
      );
      count = Number(result.rows?.[0]?.count ?? 0) || 0;
    } catch {
      // Defensive: if the active column is missing or the query fails for any
      // reason, fall back to a plain count so the wizard doesn't show a 404.
      try {
        const result = await dbQuery<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM lenders`,
        );
        count = Number(result.rows?.[0]?.count ?? 0) || 0;
      } catch {
        count = 0;
      }
    }
    return res.status(200).json(ok({ count }));
  }),
);

router.all("/lead", wrap(async (_req, res) => res.status(405).json(fail(res, "METHOD_NOT_ALLOWED"))));

// BF_SERVER_BLOCK_v738_PUBLIC_COLLATERAL - public download link for shareable
// collateral so SMS/messenger recipients can open it. Collateral is marketing
// material and keyed by an unguessable UUID, so no auth is required here.
router.get(
  "/collateral/:id/file",
  wrap(async (req, res) => {
    const id = String(req.params.id || "");
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID.test(id)) return res.status(404).json(fail(res, "NOT_FOUND"));
    const { rows } = await dbQuery<{ name: string; content_type: string | null; blob_name: string }>(
      `SELECT name, content_type, blob_name FROM collateral_assets WHERE id = $1 LIMIT 1`,
      [id],
    );
    const row = rows[0];
    if (!row) return res.status(404).json(fail(res, "NOT_FOUND"));
    const { getStorage } = await import("../lib/storage/index.js");
    const obj = await getStorage().get(row.blob_name);
    if (!obj) return res.status(404).json(fail(res, "NOT_FOUND"));
    res.setHeader("Content-Type", row.content_type || obj.contentType || "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${String(row.name).replace(/"/g, "")}"`);
    return res.send(obj.buffer);
  }),
);

// BF_SERVER_BLOCK_v684_VISITOR_THREAD_v1
// Public (UUID-as-token) read/post for the visitor side of the messenger.
// After "Talk to a Human" the widget holds the conversation_id (unguessable
// UUID). These let the anonymous visitor receive staff replies and post
// follow-ups into the SAME communications_conversations thread the staff
// inbox (v683) reads/writes - two-way without exposing other conversations.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

router.get(
  "/conversation/:id/messages",
  wrap(async (req, res) => {
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) return res.status(400).json(fail(res, "INVALID_INPUT"));
    const result = await dbQuery<{ id: string; direction: string; body: string; created_at: string }>(
      `SELECT id, direction, body, created_at
         FROM communications_messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC
        LIMIT 500`,
      [id],
    );
    return res.status(200).json(ok({ messages: result.rows }));
  }),
);

router.post(
  "/conversation/:id/message",
  wrap(async (req, res) => {
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) return res.status(400).json(fail(res, "INVALID_INPUT"));
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!body) return res.status(400).json(fail(res, "INVALID_INPUT"));
    const conv = await dbQuery<{ id: string; contact_id: string | null; silo: string | null; contact_phone: string | null }>(
      `SELECT id, contact_id, silo, contact_phone FROM communications_conversations WHERE id = $1`,
      [id],
    );
    if (!conv.rows?.[0]) return res.status(404).json(fail(res, "NOT_FOUND"));
    const convContactId = conv.rows[0].contact_id;
    const convSilo = conv.rows[0].silo ?? "BF";
    const convPhone = conv.rows[0].contact_phone;
    // BF_SERVER_BLOCK_v686_MAYA_CRM_UNIFY_v1 - carry contact_id + silo +
    // type='message' so visitor follow-ups also surface in the staff Messages
    // tab and the CRM timeline, not just the conversation_id poll.
    const inserted = await dbQuery<{ id: string; direction: string; body: string; created_at: string }>(
      `INSERT INTO communications_messages
         (id, conversation_id, contact_id, channel, type, direction, body, silo, from_number, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'messenger', 'message', 'inbound', $3, $4, $5, NOW())
       RETURNING id, direction, body, created_at`,
      [id, convContactId, body, convSilo, convPhone],
    );
    await dbQuery(
      `UPDATE communications_conversations
          SET last_message_preview = $2, last_message_at = NOW(), unread = unread + 1, updated_at = NOW()
        WHERE id = $1`,
      [id, body.slice(0, 200)],
    );
    return res.status(201).json(ok({ message: inserted.rows[0] }));
  }),
);

export default router;
