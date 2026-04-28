// BF_MINI_PORTAL_NOTES_v47 + BF_NOTIFICATIONS_v50 — application-scoped notes.
// Mounted at /api/applications/:id/notes by routeRegistry.
import { Router } from "express";
import { runQuery } from "../lib/db.js";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/errors.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { parseAndResolveMentions } from "../services/notes/mentions.js";
import { notifyMentions } from "../services/notifications/notifications.service.js";

const router = Router({ mergeParams: true });

const noteShape = `n.id, n.body, n.application_id, n.contact_id, n.company_id, n.silo,
                   n.owner_id, n.mentions, n.is_deleted, n.created_at, n.updated_at,
                   COALESCE(u.first_name || ' ' || u.last_name, u.email) AS owner_name`;

router.get(
  "/",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const applicationId = String(req.params.id ?? "").trim();
    if (!applicationId) throw new AppError("validation_error", "application id required.", 400);
    const silo = String(req.user?.silo ?? "BF").toUpperCase();
    const r = await runQuery(
      `SELECT ${noteShape} FROM crm_notes n
         LEFT JOIN users u ON u.id = n.owner_id
        WHERE n.application_id = $1 AND n.silo = $2 AND n.is_deleted = false
        ORDER BY n.created_at DESC LIMIT 200`,
      [applicationId, silo]
    );
    res.status(200).json({ ok: true, items: r.rows });
  })
);

router.post(
  "/",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const applicationId = String(req.params.id ?? "").trim();
    const body = String(req.body?.body ?? "").trim();
    if (!applicationId) throw new AppError("validation_error", "application id required.", 400);
    if (!body) throw new AppError("validation_error", "body required.", 400);
    const silo = String(req.user?.silo ?? "BF").toUpperCase();
    const mentions = await parseAndResolveMentions(body);
    const r = await runQuery<{ id: string; mentions: string[]; application_id: string; created_at: Date; updated_at: Date }>(
      `INSERT INTO crm_notes (body, owner_id, application_id, silo, mentions, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,now(),now())
       RETURNING id, body, application_id, owner_id, mentions, created_at, updated_at`,
      [body, req.user?.id ?? req.user?.userId ?? null, applicationId, silo, mentions]
    );
    const note = r.rows[0];

    // BF_NOTIFICATIONS_v50 — fan out @mentions for new notes (no previous mentions).
    await notifyMentions({
      newMentions: mentions,
      previousMentions: [],
      refTable: "crm_notes",
      refId: note.id,
      body,
      contextUrl: `/applications/${applicationId}`,
    });

    res.status(201).json({ ok: true, data: note });
  })
);

router.patch(
  "/:noteId",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const noteId = String(req.params.noteId ?? "").trim();
    const body = String(req.body?.body ?? "").trim();
    if (!noteId) throw new AppError("validation_error", "noteId required.", 400);
    if (!body) throw new AppError("validation_error", "body required.", 400);

    // BF_NOTIFICATIONS_v50 — fetch previous mentions before UPDATE so we can diff.
    const prev = await runQuery<{ mentions: string[]; application_id: string | null }>(
      `SELECT mentions, application_id FROM crm_notes WHERE id=$1 AND is_deleted=false LIMIT 1`,
      [noteId]
    );
    if (!prev.rows[0]) throw new AppError("not_found", "Note not found.", 404);
    const previousMentions = prev.rows[0].mentions ?? [];
    const applicationId = prev.rows[0].application_id;

    const mentions = await parseAndResolveMentions(body);
    const r = await runQuery(
      `UPDATE crm_notes
          SET body=$1, mentions=$2, updated_at=now()
        WHERE id=$3 AND is_deleted=false
        RETURNING id, body, application_id, mentions, owner_id, updated_at`,
      [body, mentions, noteId]
    );
    if (!r.rows[0]) throw new AppError("not_found", "Note not found.", 404);

    await notifyMentions({
      newMentions: mentions,
      previousMentions,
      refTable: "crm_notes",
      refId: noteId,
      body,
      contextUrl: applicationId ? `/applications/${applicationId}` : null,
    });

    res.status(200).json({ ok: true, data: r.rows[0] });
  })
);

router.delete(
  "/:noteId",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const noteId = String(req.params.noteId ?? "").trim();
    if (!noteId) throw new AppError("validation_error", "noteId required.", 400);
    const r = await runQuery(
      `UPDATE crm_notes SET is_deleted=true, updated_at=now()
        WHERE id=$1 AND is_deleted=false RETURNING id`,
      [noteId]
    );
    if (!r.rows[0]) throw new AppError("not_found", "Note not found.", 404);
    res.status(200).json({ ok: true, id: noteId });
  })
);

export default router;
