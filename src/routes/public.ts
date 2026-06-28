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
