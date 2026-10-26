// BF_SERVER_v856_CRM_UNIFY - a merged contact points at the record it was merged into (contacts.merged_into_id), and
// that record may itself have been merged later. Follow the chain to the live survivor so a merged record is never
// offered as a duplicate, never used as a merge target, and its page can send staff to the right place.
import type { Q } from "./tags.js";

export type SurvivorInfo = {
  id: string;            // the record at the end of the chain (the input id when it was never merged)
  requestedId: string;
  merged: boolean;       // true when the requested record was merged into another
  archived: boolean;     // the end of the chain is archived (not merged) - it has to be restored before use
  missing: boolean;      // the requested record does not exist in this silo
  name: string | null;
};

export async function resolveContactSurvivor(db: Q, contactId: string, silo: string): Promise<SurvivorInfo> {
  const seen = new Set<string>();
  let id = contactId;
  let name: string | null = null;
  let archived = false;
  for (let hop = 0; hop < 20; hop++) {
    if (seen.has(id)) break; // a circular merge (A -> B -> A): stop at the last record reached
    seen.add(id);
    const r = await db.query(
      `SELECT id::text AS id, merged_into_id::text AS merged_into_id, coalesce(status, 'active') AS status, name
         FROM contacts WHERE id = $1::uuid AND silo = $2`,
      [id, silo],
    );
    const row = r.rows[0];
    if (!row) {
      if (hop === 0) return { id: contactId, requestedId: contactId, merged: false, archived: false, missing: true, name: null };
      break;
    }
    name = row.name ?? null;
    archived = row.status === "archived";
    if (!row.merged_into_id) break;
    const next = String(row.merged_into_id);
    const exists = await db.query(`SELECT 1 FROM contacts WHERE id = $1::uuid AND silo = $2`, [next, silo]);
    if (!exists.rows.length) break; // the survivor was deleted: this record is the best there is
    id = next;
  }
  return { id, requestedId: contactId, merged: id !== contactId, archived, missing: false, name };
}
