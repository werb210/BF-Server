// BF_SERVER_BLOCK_v_CONTACTS_OUTLOOK_SYNC_v1
// One-way sync: push a CRM contact into its owner's Outlook contacts so caller-ID
// and email/mobile autocomplete work everywhere. Best-effort / fire-and-forget.
import type { Pool } from "pg";
import { getGraphForUser } from "./graphClient.js";

interface ContactRow {
  id: string; first_name: string | null; last_name: string | null; name: string | null;
  email: string | null; phone: string | null; company_name: string | null;
  owner_id: string | null; outlook_contact_id: string | null;
}

export async function pushContactToOutlook(pool: Pool, contactId: string): Promise<void> {
  try {
    const r = await pool.query<ContactRow>(
      `SELECT id, first_name, last_name, name, email, phone, company_name, owner_id, outlook_contact_id
         FROM contacts WHERE id = $1 LIMIT 1`, [contactId]);
    const c = r.rows[0];
    if (!c || !c.owner_id) return;
    const graph = await getGraphForUser(pool, c.owner_id);
    if (!graph) return;
    const payload: Record<string, unknown> = {
      givenName: c.first_name ?? undefined,
      surname: c.last_name ?? undefined,
      displayName: c.name ?? ([c.first_name, c.last_name].filter(Boolean).join(" ") || undefined),
      companyName: c.company_name ?? undefined,
    };
    if (c.email) payload.emailAddresses = [{ address: c.email, name: c.name ?? c.email }];
    if (c.phone) payload.businessPhones = [c.phone];
    const path = c.outlook_contact_id ? `/me/contacts/${c.outlook_contact_id}` : `/me/contacts`;
    const resp = await graph.fetch(path, {
      method: c.outlook_contact_id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) return;
    if (!c.outlook_contact_id) {
      const j = await resp.json().catch(() => null);
      if (j?.id) await pool.query(`UPDATE contacts SET outlook_contact_id = $1 WHERE id = $2`, [j.id, c.id]).catch(() => {});
    }
  } catch { /* best-effort */ }
}
