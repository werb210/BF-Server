// BF_SERVER_CONTACTS_PULL_v1 - enrich existing CRM contacts by linking them to the
// matching Outlook contact (by email) so future pushes update in place and caller-ID
// resolves both ways. Enrich-only: does NOT mass-import Outlook contacts into the CRM.
//
// BF_SERVER_v864_CONTACTS_PULL_FIX - what "Sync now" does, end to end:
//   1. Reads the signed-in user's Outlook contacts (Graph /me/contacts, every page), with their email addresses and
//      phone numbers.
//   2. Links each CRM contact the user owns whose email matches ANY of the Outlook contact's addresses (was: only the
//      first one) by storing contacts.outlook_contact_id. Later edits in the CRM then PATCH that Outlook contact
//      (contactSync.ts) instead of creating a duplicate.
//   3. Caller ID both ways:
//        - Outlook -> Boreal: a linked CRM contact with no phone gets the Outlook number, so an inbound call from it
//          resolves to the contact in Boreal (caller ID matches the last 10 digits of contacts.phone).
//        - Boreal -> phone: a linked Outlook contact with no phone gets the CRM number, so the phone's own caller ID
//          (Outlook contacts synced to iOS / Android) shows the name.
//      Existing numbers are never overwritten on either side.
//   4. Reports what it did. Before this fix a missing Microsoft 365 connection or a Graph error (no Contacts
//      permission) still answered "Linked 0 contacts", so it looked like it worked.
import type { Pool } from "pg";
import { getGraphForUser, type GraphClient } from "./graphClient.js";

export type ContactPullResult = {
  connected: boolean;
  /** Outlook contacts read. */
  scanned: number;
  /** CRM contacts newly linked to an Outlook contact. */
  linked: number;
  /** Linked CRM contacts that had no phone and got the Outlook number. */
  phonesAddedToCrm: number;
  /** Linked Outlook contacts that had no phone and got the CRM number. */
  phonesAddedToOutlook: number;
  /** Set when Graph refused: "missing_permission" (401/403) or "graph_failed". */
  error?: "missing_permission" | "graph_failed";
  detail?: string;
};

type OutlookContact = { id?: string; emailAddresses?: Array<{ address?: string }>; businessPhones?: string[]; mobilePhone?: string | null; homePhones?: string[] };

export function outlookEmails(c: OutlookContact): string[] {
  const out = new Set<string>();
  for (const e of Array.isArray(c.emailAddresses) ? c.emailAddresses : []) {
    const a = String(e?.address ?? "").trim().toLowerCase();
    if (a.includes("@")) out.add(a);
  }
  return [...out];
}

/** The first usable Outlook number (mobile first: it is the one that calls). */
export function outlookPhone(c: OutlookContact): string | null {
  const candidates = [c.mobilePhone, ...(Array.isArray(c.businessPhones) ? c.businessPhones : []), ...(Array.isArray(c.homePhones) ? c.homePhones : [])];
  for (const p of candidates) {
    const digits = String(p ?? "").replace(/[^\d]/g, "");
    if (digits.length >= 10) return String(p).trim();
  }
  return null;
}

/** Store numbers the way the CRM does: +1XXXXXXXXXX for North American numbers, otherwise as typed. */
export function toCrmPhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return raw.trim();
}

export async function pullOutlookContactsForUser(pool: Pool, userId: string): Promise<ContactPullResult> {
  const result: ContactPullResult = { connected: false, scanned: 0, linked: 0, phonesAddedToCrm: 0, phonesAddedToOutlook: 0 };
  const graph: GraphClient | null = await getGraphForUser(pool, userId);
  if (!graph) return result;
  result.connected = true;
  let url: string | null = "/me/contacts?$top=100&$select=id,emailAddresses,businessPhones,mobilePhone,homePhones";
  let guard = 0;
  while (url && guard < 50) {
    guard += 1;
    const r = await graph.fetch(url);
    if (!r.ok) {
      const detail = (await r.text().catch(() => "")).slice(0, 300);
      console.warn("[contacts-pull] Graph refused /me/contacts", { userId, status: r.status, page: guard, detail });
      result.error = r.status === 401 || r.status === 403 ? "missing_permission" : "graph_failed";
      result.detail = detail;
      break;
    }
    const j: any = await r.json().catch((err: unknown) => {
      console.warn("[contacts-pull] unreadable Graph page", { userId, message: err instanceof Error ? err.message : String(err) });
      return null;
    });
    const items: OutlookContact[] = Array.isArray(j?.value) ? j.value : [];
    for (const it of items) {
      result.scanned += 1;
      const oid = it?.id;
      const emails = outlookEmails(it);
      if (!oid || emails.length === 0) continue;
      const upd = await pool.query<{ id: string; phone: string | null }>(
        `UPDATE contacts SET outlook_contact_id = $1, updated_at = now()
          WHERE owner_id = $2 AND lower(email) = ANY($3::text[]) AND (outlook_contact_id IS NULL OR outlook_contact_id = '')
          RETURNING id, phone`,
        [oid, userId, emails],
      );
      const rows = upd.rows ?? [];
      result.linked += upd.rowCount ?? rows.length;
      if (rows.length === 0) continue;
      const fromOutlook = outlookPhone(it);
      for (const row of rows) {
        const hasCrmPhone = String(row.phone ?? "").replace(/[^\d]/g, "").length >= 10;
        if (!hasCrmPhone && fromOutlook) {
          const set = await pool.query(
            `UPDATE contacts SET phone = $2, updated_at = now() WHERE id = $1 AND (phone IS NULL OR btrim(phone) = '')`,
            [row.id, toCrmPhone(fromOutlook)],
          );
          result.phonesAddedToCrm += set.rowCount ?? 0;
        }
      }
      const crmPhone = rows.map((x) => x.phone).find((p) => String(p ?? "").replace(/[^\d]/g, "").length >= 10);
      if (!fromOutlook && crmPhone) {
        const p = await graph.fetch(`/me/contacts/${encodeURIComponent(oid)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ businessPhones: [crmPhone] }),
        });
        if (p.ok) result.phonesAddedToOutlook += 1;
        else console.warn("[contacts-pull] could not add the CRM number to Outlook", { userId, outlookId: oid, status: p.status });
      }
    }
    const next: unknown = j?.["@odata.nextLink"];
    url = typeof next === "string" ? next.replace("https://graph.microsoft.com/v1.0", "") : null;
  }
  return result;
}
