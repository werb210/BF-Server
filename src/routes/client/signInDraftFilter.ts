// BF_SERVER_v838_SIGNIN_SKIPS_UNSUBMITTED - which applications sign-in may open in the client portal.
//
// The wizard creates the client's application at 'Received' (not 'draft') the moment they start, so the sign-in
// lookup (GET /api/client/applications/by-phone without includeDrafts) found an unfinished one and opened the
// client portal on a form that was never sent: "You're all caught up". Applications the client started in the
// wizard (source client_direct or readiness_continuation) and never submitted are left out, so sign-in carries on
// to the wizard. Files staff created or imported for the client are not affected.
export const UNSUBMITTED_CLIENT_DRAFT_EXCLUSION =
  "AND NOT (a.submitted_at IS NULL AND lower(coalesce(a.source, '')) IN ('client_direct', 'readiness_continuation'))";

// BF_SERVER_v839_CLIENT_DRAFT_CLEANUP - tidying the client portal's list of applications.
const CLIENT_STARTED = new Set(["client_direct", "readiness_continuation"]);

/** Applications the client removed from their list (Remove in the switcher). Staff still see them. */
export const CLIENT_REMOVED_EXCLUSION = "AND coalesce(a.metadata->>'client_removed', '') <> 'true'";

function isUnfinishedClientDraft(row: any): boolean {
  return row?.submitted_at == null && CLIENT_STARTED.has(String(row?.source ?? "").toLowerCase());
}

/** Rows arrive newest first. Keeps every sent or staff-made application and only the newest unfinished one the
 * client started; the older ones were left behind by earlier sign-ins. */
export function keepNewestUnfinished<T>(rows: T[]): T[] {
  let kept = false;
  return rows.filter((row) => {
    if (!isUnfinishedClientDraft(row)) return true;
    if (kept) return false;
    kept = true;
    return true;
  });
}

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/** Marks the named unfinished application, and the caller's older unfinished ones, as removed from their list.
 * Returns how many were marked, or null when the named one is not an unfinished application the caller started. */
export async function removeUnfinishedDrafts(db: Q, applicationId: string, phone10: string): Promise<number | null> {
  const mine = `SELECT a.id FROM applications a
                  JOIN contacts c ON c.id = a.contact_id
                 WHERE right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = $1
                   AND a.submitted_at IS NULL
                   AND lower(coalesce(a.source, '')) IN ('client_direct', 'readiness_continuation')`;
  const target = await db.query(`${mine} AND a.id::text = $2`, [phone10, applicationId]);
  if (!target.rows.length) return null;
  const r = await db.query(
    `UPDATE applications
        SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('client_removed', true, 'client_removed_at', now())
      WHERE id IN (${mine})
        AND updated_at <= (SELECT updated_at FROM applications WHERE id::text = $2)
        AND coalesce(metadata->>'client_removed', '') <> 'true'`,
    [phone10, applicationId],
  );
  return r.rowCount ?? 0;
}
