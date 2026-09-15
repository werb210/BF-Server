// BF_SERVER_SUGGESTED_NEXT_ACTIONS_v207
// Per-application "what should someone do about this next".
//
// Distinct from /staff/daily-briefing, which counts things across the silo. This
// names the specific file and the specific action, because a count of "4 stale
// deals" does not tell anyone which four or what to do about them.
//
// Deliberately rule-based, not opaque scoring. Every suggestion has to be
// explainable to the person acting on it - "no lender response in 4 days" is
// actionable, while an unexplained numeric score is not. The doc calls for
// recommendation-first with controlled automation later; nothing here writes,
// it only suggests.
import { dbQuery } from "../db.js";

export type NextAction = {
  applicationId: string;
  businessName: string | null;
  contactId: string | null;
  action: string;
  reason: string;
  // Higher sorts first. Set from how time-sensitive the signal is, not from how
  // large the deal is - chasing a promise made yesterday beats a stale file.
  priority: number;
};

const SUGGESTION_SQL = `
WITH live AS (
  SELECT a.id::text AS id, a.name AS business_name, a.contact_id::text AS contact_id,
         a.updated_at, a.silo
    FROM applications a
   WHERE ($1::text IS NULL OR a.silo = $1)
     AND COALESCE(a.pipeline_state, a.status, '') !~* 'funded|declined|closed|rejected'
)

-- A promise made on a call, with nothing filed since. This is the signal the
-- v145 disposition workflow exists to produce, and the one staff most often lose.
SELECT l.id AS application_id, l.business_name, l.contact_id,
       'Call client - documents were promised' AS action,
       'Promised on a call ' || date_trunc('day', now() - cl.created_at) || ' ago, nothing uploaded since' AS reason,
       100 AS priority
  FROM live l
  JOIN call_logs cl ON cl.crm_contact_id::text = l.contact_id
 WHERE cl.disposition = 'documents_promised'
   AND cl.created_at > now() - interval '30 days'
   AND NOT EXISTS (
     SELECT 1 FROM documents d
      WHERE d.application_id::text = l.id
        AND d.created_at > cl.created_at
        AND d.deleted_at IS NULL
   )

UNION ALL

-- Sent to lenders, and every one of them has passed.
SELECT l.id, l.business_name, l.contact_id,
       'Re-match lenders - every lender has passed' AS action,
       'All ' || COUNT(r.id)::text || ' lender(s) declined' AS reason,
       90 AS priority
  FROM live l
  JOIN application_lender_responses r ON r.application_id = l.id
 GROUP BY l.id, l.business_name, l.contact_id
HAVING COUNT(*) FILTER (WHERE r.outcome <> 'declined') = 0
   AND COUNT(*) > 0

UNION ALL

-- Documents asked for and not accepted, with no movement for a week.
SELECT l.id, l.business_name, l.contact_id,
       'Chase outstanding documents' AS action,
       COUNT(d.id)::text || ' document(s) still not accepted, quiet for 7+ days' AS reason,
       70 AS priority
  FROM live l
  JOIN application_required_documents d ON d.application_id::text = l.id
 WHERE d.status <> 'accepted'
   AND l.updated_at < now() - interval '7 days'
 GROUP BY l.id, l.business_name, l.contact_id

UNION ALL

-- Nothing at all has happened for a fortnight.
SELECT l.id, l.business_name, l.contact_id,
       'Follow up - the file has gone quiet' AS action,
       'No activity for ' || EXTRACT(day FROM now() - l.updated_at)::int::text || ' days' AS reason,
       50 AS priority
  FROM live l
 WHERE l.updated_at < now() - interval '14 days'
`;

export async function buildNextActions(
  silo: string | null,
  limit = 25,
): Promise<NextAction[]> {
  const r = await dbQuery<{
    application_id: string;
    business_name: string | null;
    contact_id: string | null;
    action: string;
    reason: string;
    priority: number;
  }>(SUGGESTION_SQL, [silo]).catch(() => ({ rows: [] as any[] }));

  const rows = r.rows ?? [];

  // One suggestion per application - the most urgent. Showing staff four things
  // to do about the same file is how a list like this gets ignored.
  const best = new Map<string, NextAction>();
  for (const row of rows) {
    const item: NextAction = {
      applicationId: row.application_id,
      businessName: row.business_name,
      contactId: row.contact_id,
      action: row.action,
      reason: row.reason,
      priority: Number(row.priority) || 0,
    };
    const prior = best.get(item.applicationId);
    if (!prior || item.priority > prior.priority) best.set(item.applicationId, item);
  }

  return Array.from(best.values())
    .sort((a, b) => b.priority - a.priority || a.applicationId.localeCompare(b.applicationId))
    .slice(0, Math.max(1, Math.min(limit, 100)));
}
