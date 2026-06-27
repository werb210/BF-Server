// BF_SERVER_LENDER_QA_v1
// Staff <-> client lender question/answer round-trips.
// Staff compose 1-99 questions in the Lenders tab; the client answers in the
// CMP; staff accept/reject each answer (reject needs a reason and returns only
// that question); when every answer is accepted the set finalizes and its
// export (block #2) attaches to the lender package.
//
// Mounted at /api/portal by the route registry, so paths below resolve to
// /api/portal/applications/:id/qa/...
import { Router, type Response, type NextFunction } from "express";
import { pool } from "../db.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { sendSMS } from "../services/smsService.js";

const router: Router = Router();

const ANSWERABLE = ["sent", "rejected"]; // question states the client must act on

function requireStaffOrAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  const role = (req.user as { role?: string } | undefined)?.role;
  if (role === ROLES.ADMIN || role === ROLES.STAFF) {
    next();
    return;
  }
  res.status(403).json({ error: "Forbidden" });
}

// Post a CMP chat nudge (with an "Answer lender questions" button) + an SMS to
// the applicant. cta_action 'lender_qa' is the button the client app renders.
async function notifyClient(appId: string, count: number): Promise<void> {
  const body =
    count === 1
      ? "The lender has a question about your application. Please answer it using the button below."
      : `The lender has ${count} questions about your application. Please answer them using the button below.`;
  try {
    await pool.query(
      `INSERT INTO communications_messages
         (id, type, direction, status, application_id, contact_id, silo, body, staff_name, cta_label, cta_action, created_at)
       VALUES (gen_random_uuid(), 'message', 'outbound', 'sent', $1,
         (SELECT contact_id FROM applications WHERE id::text = ($1)::text LIMIT 1),
         COALESCE((SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1), 'BF'),
         $2, 'Boreal Financial', 'Answer lender questions', 'lender_qa', now())`,
      [appId, body],
    );
  } catch (e) {
    console.warn("[qa] nudge failed", e instanceof Error ? e.message : String(e));
  }
  try {
    const r = await pool.query<{ phone: string | null }>(
      `SELECT c.phone AS phone FROM applications a LEFT JOIN contacts c ON c.id = a.contact_id WHERE a.id::text = ($1)::text LIMIT 1`,
      [appId],
    );
    const phone = r.rows[0]?.phone;
    if (phone) {
      await sendSMS(
        String(phone),
        "Boreal Financial: the lender has questions about your application. Please open your application to answer them.",
      );
    }
  } catch (e) {
    console.warn("[qa] sms failed", e instanceof Error ? e.message : String(e));
  }
}

async function loadSetWithQuestions(setId: string) {
  const setRes = await pool.query(
    `SELECT id, application_id, silo, round, status, created_at, updated_at, finalized_at
       FROM qa_sets WHERE id = $1 LIMIT 1`,
    [setId],
  );
  const set = setRes.rows[0];
  if (!set) return null;
  const qRes = await pool.query(
    `SELECT id, set_id, position, prompt, request_document, answer_text, answer_document_id,
            review_status, reject_reason, answered_at, reviewed_at
       FROM qa_questions WHERE set_id = $1 ORDER BY position ASC`,
    [setId],
  );
  return { ...set, questions: qRes.rows };
}

// ---------------------------------------------------------------------------
// STAFF endpoints (Lenders tab)
// ---------------------------------------------------------------------------

// List every Q&A set + its questions for an application.
router.get(
  "/applications/:id/qa/sets",
  requireAuth,
  requireStaffOrAdmin,
  async (req: AuthRequest, res: Response) => {
    const appId = String(req.params.id);
    try {
      const sets = await pool.query(
        `SELECT id FROM qa_sets WHERE application_id = $1 ORDER BY round ASC`,
        [appId],
      );
      const items = [];
      for (const row of sets.rows) {
        const full = await loadSetWithQuestions(String(row.id));
        if (full) items.push(full);
      }
      res.json({ items });
    } catch (e) {
      console.error("[qa.listSets] failed", e);
      res.status(500).json({ error: "internal" });
    }
  },
);

// Create a new (draft) question set for an application.
router.post(
  "/applications/:id/qa/sets",
  requireAuth,
  requireStaffOrAdmin,
  async (req: AuthRequest, res: Response) => {
    const appId = String(req.params.id);
    const silo = resolveSiloFromRequest(req);
    try {
      const r = await pool.query(
        `INSERT INTO qa_sets (application_id, silo, round, status, created_by)
         VALUES ($1, $2,
           (SELECT COALESCE(MAX(round), 0) + 1 FROM qa_sets WHERE application_id = $1),
           'draft', $3)
         RETURNING id`,
        [appId, silo, req.user?.id ? String(req.user.id) : null],
      );
      const full = await loadSetWithQuestions(String(r.rows[0].id));
      res.status(201).json({ set: full });
    } catch (e) {
      console.error("[qa.createSet] failed", e);
      res.status(500).json({ error: "internal" });
    }
  },
);

// Add a question to a (draft or sent) set.
router.post(
  "/applications/:id/qa/sets/:setId/questions",
  requireAuth,
  requireStaffOrAdmin,
  async (req: AuthRequest, res: Response) => {
    const setId = String(req.params.setId);
    const prompt = String(req.body?.prompt ?? "").trim();
    const requestDocument = Boolean(req.body?.request_document);
    if (!prompt) {
      res.status(400).json({ error: "prompt_required" });
      return;
    }
    try {
      const countRes = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::int AS n FROM qa_questions WHERE set_id = $1`,
        [setId],
      );
      if (Number(countRes.rows[0]?.n ?? 0) >= 99) {
        res.status(400).json({ error: "max_questions" });
        return;
      }
      await pool.query(
        `INSERT INTO qa_questions (set_id, position, prompt, request_document, review_status)
         VALUES ($1, (SELECT COALESCE(MAX(position), 0) + 1 FROM qa_questions WHERE set_id = $1), $2, $3, 'draft')`,
        [setId, prompt, requestDocument],
      );
      res.status(201).json({ set: await loadSetWithQuestions(setId) });
    } catch (e) {
      console.error("[qa.addQuestion] failed", e);
      res.status(500).json({ error: "internal" });
    }
  },
);

// Edit a question (prompt / request_document) while still composable.
router.patch(
  "/applications/:id/qa/questions/:qid",
  requireAuth,
  requireStaffOrAdmin,
  async (req: AuthRequest, res: Response) => {
    const qid = String(req.params.qid);
    const prompt = req.body?.prompt === undefined ? null : String(req.body.prompt).trim();
    const requestDocument =
      req.body?.request_document === undefined ? null : Boolean(req.body.request_document);
    try {
      const r = await pool.query<{ set_id: string }>(
        `UPDATE qa_questions
            SET prompt = COALESCE($2, prompt),
                request_document = COALESCE($3, request_document),
                updated_at = now()
          WHERE id = $1
          RETURNING set_id`,
        [qid, prompt, requestDocument],
      );
      if (!r.rows[0]) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({ set: await loadSetWithQuestions(String(r.rows[0].set_id)) });
    } catch (e) {
      console.error("[qa.editQuestion] failed", e);
      res.status(500).json({ error: "internal" });
    }
  },
);

// Delete a question.
router.delete(
  "/applications/:id/qa/questions/:qid",
  requireAuth,
  requireStaffOrAdmin,
  async (req: AuthRequest, res: Response) => {
    const qid = String(req.params.qid);
    try {
      const r = await pool.query<{ set_id: string }>(
        `DELETE FROM qa_questions WHERE id = $1 RETURNING set_id`,
        [qid],
      );
      if (!r.rows[0]) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({ set: await loadSetWithQuestions(String(r.rows[0].set_id)) });
    } catch (e) {
      console.error("[qa.deleteQuestion] failed", e);
      res.status(500).json({ error: "internal" });
    }
  },
);

// Submit a set to the client: mark draft questions 'sent', set 'sent',
// then nudge the client (CMP chat + SMS).
router.post(
  "/applications/:id/qa/sets/:setId/submit",
  requireAuth,
  requireStaffOrAdmin,
  async (req: AuthRequest, res: Response) => {
    const appId = String(req.params.id);
    const setId = String(req.params.setId);
    try {
      const upd = await pool.query<{ n: string }>(
        `WITH moved AS (
           UPDATE qa_questions SET review_status = 'sent', updated_at = now()
            WHERE set_id = $1 AND review_status = 'draft'
            RETURNING 1
         )
         SELECT COUNT(*)::int AS n FROM moved`,
        [setId],
      );
      await pool.query(
        `UPDATE qa_sets SET status = 'sent', updated_at = now() WHERE id = $1`,
        [setId],
      );
      const awaiting = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::int AS n FROM qa_questions WHERE set_id = $1 AND review_status = ANY($2::text[])`,
        [setId, ANSWERABLE],
      );
      const count = Number(awaiting.rows[0]?.n ?? upd.rows[0]?.n ?? 0);
      if (count > 0) await notifyClient(appId, count);
      res.json({ set: await loadSetWithQuestions(setId) });
    } catch (e) {
      console.error("[qa.submitSet] failed", e);
      res.status(500).json({ error: "internal" });
    }
  },
);

// Withdraw a whole set.
router.post(
  "/applications/:id/qa/sets/:setId/withdraw",
  requireAuth,
  requireStaffOrAdmin,
  async (req: AuthRequest, res: Response) => {
    const setId = String(req.params.setId);
    try {
      await pool.query(
        `UPDATE qa_sets SET status = 'withdrawn', updated_at = now() WHERE id = $1`,
        [setId],
      );
      res.json({ set: await loadSetWithQuestions(setId) });
    } catch (e) {
      console.error("[qa.withdrawSet] failed", e);
      res.status(500).json({ error: "internal" });
    }
  },
);

// Accept a single answer.
router.post(
  "/applications/:id/qa/questions/:qid/accept",
  requireAuth,
  requireStaffOrAdmin,
  async (req: AuthRequest, res: Response) => {
    const qid = String(req.params.qid);
    try {
      const r = await pool.query<{ set_id: string }>(
        `UPDATE qa_questions
            SET review_status = 'accepted', reject_reason = NULL, reviewed_at = now(), updated_at = now()
          WHERE id = $1
          RETURNING set_id`,
        [qid],
      );
      if (!r.rows[0]) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({ set: await loadSetWithQuestions(String(r.rows[0].set_id)) });
    } catch (e) {
      console.error("[qa.accept] failed", e);
      res.status(500).json({ error: "internal" });
    }
  },
);

// Reject a single answer (reason required) and send it back to the client.
router.post(
  "/applications/:id/qa/questions/:qid/reject",
  requireAuth,
  requireStaffOrAdmin,
  async (req: AuthRequest, res: Response) => {
    const appId = String(req.params.id);
    const qid = String(req.params.qid);
    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) {
      res.status(400).json({ error: "reason_required" });
      return;
    }
    try {
      const r = await pool.query<{ set_id: string }>(
        `UPDATE qa_questions
            SET review_status = 'rejected', reject_reason = $2, reviewed_at = now(), updated_at = now()
          WHERE id = $1
          RETURNING set_id`,
        [qid, reason],
      );
      if (!r.rows[0]) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await pool.query(
        `UPDATE qa_sets SET status = 'sent', updated_at = now() WHERE id = $1`,
        [String(r.rows[0].set_id)],
      );
      await notifyClient(appId, 1);
      res.json({ set: await loadSetWithQuestions(String(r.rows[0].set_id)) });
    } catch (e) {
      console.error("[qa.reject] failed", e);
      res.status(500).json({ error: "internal" });
    }
  },
);

// Finalize a set: only when every question is accepted.
router.post(
  "/applications/:id/qa/sets/:setId/finalize",
  requireAuth,
  requireStaffOrAdmin,
  async (req: AuthRequest, res: Response) => {
    const setId = String(req.params.setId);
    try {
      const pending = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::int AS n FROM qa_questions WHERE set_id = $1 AND review_status <> 'accepted'`,
        [setId],
      );
      const total = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::int AS n FROM qa_questions WHERE set_id = $1`,
        [setId],
      );
      if (Number(total.rows[0]?.n ?? 0) === 0 || Number(pending.rows[0]?.n ?? 0) > 0) {
        res.status(400).json({ error: "not_all_accepted" });
        return;
      }
      await pool.query(
        `UPDATE qa_sets SET status = 'finalized', finalized_at = now(), updated_at = now() WHERE id = $1`,
        [setId],
      );
      res.json({ set: await loadSetWithQuestions(setId) });
    } catch (e) {
      console.error("[qa.finalize] failed", e);
      res.status(500).json({ error: "internal" });
    }
  },
);

// ---------------------------------------------------------------------------
// CLIENT endpoints (CMP) -- requireAuth only (the applicant is authenticated
// via OTP), mirroring application_form_responses.
// ---------------------------------------------------------------------------

// The questions the client currently needs to answer (sent or rejected).
router.get(
  "/applications/:id/qa/open",
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    const appId = String(req.params.id);
    try {
      const setRes = await pool.query(
        `SELECT id, round, status FROM qa_sets
          WHERE application_id = $1 AND status IN ('sent', 'answered')
          ORDER BY round DESC LIMIT 1`,
        [appId],
      );
      const set = setRes.rows[0];
      if (!set) {
        res.json({ set: null, questions: [] });
        return;
      }
      const qRes = await pool.query(
        `SELECT id, position, prompt, request_document, answer_text, answer_document_id, review_status, reject_reason
           FROM qa_questions
          WHERE set_id = $1 AND review_status = ANY($2::text[])
          ORDER BY position ASC`,
        [set.id, ANSWERABLE],
      );
      res.json({ set: { id: set.id, round: set.round, status: set.status }, questions: qRes.rows });
    } catch (e) {
      console.error("[qa.clientOpen] failed", e);
      res.status(500).json({ error: "internal" });
    }
  },
);

// Autosave a single answer (kept editable until the client submits).
router.patch(
  "/applications/:id/qa/questions/:qid/answer",
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    const qid = String(req.params.qid);
    const answerText =
      req.body?.answer_text === undefined ? null : String(req.body.answer_text);
    const answerDocumentId =
      req.body?.answer_document_id === undefined ? null : String(req.body.answer_document_id);
    try {
      const r = await pool.query(
        `UPDATE qa_questions
            SET answer_text = COALESCE($2, answer_text),
                answer_document_id = COALESCE($3, answer_document_id),
                updated_at = now()
          WHERE id = $1 AND review_status = ANY($4::text[])
          RETURNING id`,
        [qid, answerText, answerDocumentId, ANSWERABLE],
      );
      if (!r.rows[0]) {
        res.status(409).json({ error: "not_answerable" });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      console.error("[qa.clientAnswer] failed", e);
      res.status(500).json({ error: "internal" });
    }
  },
);

// Submit all answers in a set: move answered questions to 'answered',
// flag the set, and notify staff.
router.post(
  "/applications/:id/qa/sets/:setId/answers/submit",
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    const appId = String(req.params.id);
    const setId = String(req.params.setId);
    const silo = resolveSiloFromRequest(req);
    try {
      const moved = await pool.query<{ n: string }>(
        `WITH m AS (
           UPDATE qa_questions
              SET review_status = 'answered', answered_at = now(), updated_at = now()
            WHERE set_id = $1
              AND review_status = ANY($2::text[])
              AND answer_text IS NOT NULL AND btrim(answer_text) <> ''
            RETURNING 1
         )
         SELECT COUNT(*)::int AS n FROM m`,
        [setId, ANSWERABLE],
      );
      await pool.query(
        `UPDATE qa_sets SET status = 'answered', updated_at = now() WHERE id = $1`,
        [setId],
      );
      try {
        const { notifyAllStaff } = await import("../services/notifications/notifyAllStaff.js");
        await notifyAllStaff({
          pool,
          notificationType: "lender_qa_answered",
          title: "Lender questions answered",
          body: "The client submitted answers to the lender questions. Review them in the Lenders tab.",
          refTable: "qa_sets",
          refId: setId,
          silo,
        });
      } catch (e) {
        console.warn("[qa] staff notify failed", e instanceof Error ? e.message : String(e));
      }
      res.json({ ok: true, answered: Number(moved.rows[0]?.n ?? 0), application_id: appId });
    } catch (e) {
      console.error("[qa.clientSubmit] failed", e);
      res.status(500).json({ error: "internal" });
    }
  },
);

// Download the finalized export for a set (staff; manual send to lender).
router.get(
  "/applications/:id/qa/sets/:setId/export",
  requireAuth,
  requireStaffOrAdmin,
  async (req: AuthRequest, res: Response) => {
    const setId = String(req.params.setId);
    try {
      const { buildQaExportForSet } = await import("../services/lenders/qaExport.js");
      const pdf = await buildQaExportForSet(setId);
      if (!pdf) {
        res.status(404).json({ error: "not_available" });
        return;
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${pdf.filename}"`);
      res.send(pdf.content);
    } catch (e) {
      console.error("[qa.export] failed", e);
      res.status(500).json({ error: "internal" });
    }
  },
);

export default router;
