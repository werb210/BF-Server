// BF_SERVER_CONTACTS_PULL_v1 - enrich existing CRM contacts by linking them to the
// matching Outlook contact (by email) so future pushes update in place and caller-ID
// resolves both ways. Enrich-only: does NOT mass-import Outlook contacts into the CRM.
import type { Pool } from "pg";
import { getGraphForUser, type GraphClient } from "./graphClient.js";

export async function pullOutlookContactsForUser(pool: Pool, userId: string): Promise<{ linked: number }> {
  let linked = 0;
  const graph: GraphClient | null = await getGraphForUser(pool, userId);
  if (!graph) return { linked };
  let url: string | null = "/me/contacts?$top=100&$select=id,emailAddresses";
  let guard = 0;
  while (url && guard < 20) {
    guard += 1;
    const r = await graph.fetch(url);
    if (!r.ok) break;
    const j: any = await r.json().catch(() => null);
    const items: any[] = Array.isArray(j?.value) ? j.value : [];
    for (const it of items) {
      const oid: string | undefined = it?.id;
      const email: string | undefined = it?.emailAddresses?.[0]?.address;
      if (!oid || !email) continue;
      const upd = await pool.query(
        `UPDATE contacts SET outlook_contact_id = $1
          WHERE owner_id = $2 AND lower(email) = lower($3) AND (outlook_contact_id IS NULL OR outlook_contact_id = '')`,
        [oid, userId, email]
      );
      linked += upd.rowCount ?? 0;
    }
    const next: unknown = j?.["@odata.nextLink"];
    url = typeof next === "string" ? next.replace("https://graph.microsoft.com/v1.0", "") : null;
  }
  return { linked };
}
