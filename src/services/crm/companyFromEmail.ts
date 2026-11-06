// BF_SERVER_v907_EMAIL_DOMAIN_COMPANY - a contact saved with a work email (not gmail, hotmail, outlook, icloud, yahoo
// and the like) is attached to the company with that domain or website in the same silo, or a company is created for
// the domain. A contact that already has a company is left alone.
import { isFreeEmailDomain } from "../../modules/crmUnify/webSource.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/** The email's domain in lower case, or null for a free provider or a malformed address. */
export function workEmailDomain(email: unknown): string | null {
  const m = /^[^@\s]+@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(String(email ?? "").trim());
  if (!m) return null;
  const domain = m[1]!.toLowerCase().replace(/^www\./, "");
  if (isFreeEmailDomain(domain)) return null;
  return domain;
}

/** "acme-steel.ca" -> "Acme Steel". */
export function companyNameFromDomain(domain: string): string {
  const label = domain.split(".")[0] ?? domain;
  return label.split(/[-_]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || domain;
}

export type CompanyLink = { company_id: string; created: boolean; domain: string } | null;

export async function linkContactToCompanyByEmail(db: Q, contactId: string): Promise<CompanyLink> {
  const c = await db.query(`SELECT id::text AS id, email, company_id, silo, owner_id FROM contacts WHERE id::text = $1 LIMIT 1`, [contactId]);
  const contact = c.rows[0];
  if (!contact || contact.company_id) return null;
  const domain = workEmailDomain(contact.email);
  if (!domain) return null;
  const silo = String(contact.silo ?? "BF");
  const existing = await db.query(
    `SELECT id::text AS id FROM companies
      WHERE silo = $1
        AND (lower(COALESCE(domain, '')) = $2
             OR lower(regexp_replace(regexp_replace(COALESCE(website, ''), '^https?://', '', 'i'), '^www\\.|/.*$', '', 'gi')) = $2)
      ORDER BY created_at ASC LIMIT 1`,
    [silo, domain],
  );
  let companyId: string | null = existing.rows[0]?.id ?? null;
  let created = false;
  if (!companyId) {
    const ins = await db.query(
      `INSERT INTO companies (id, name, website, domain, silo, owner_id, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::uuid, now(), now()) RETURNING id::text AS id`,
      [companyNameFromDomain(domain), `https://${domain}`, domain, silo, contact.owner_id ?? null],
    );
    companyId = ins.rows[0]?.id ?? null;
    created = Boolean(companyId);
  }
  if (!companyId) return null;
  await db.query(`UPDATE contacts SET company_id = $2::uuid, updated_at = now() WHERE id::text = $1 AND company_id IS NULL`, [contactId, companyId]);
  return { company_id: companyId, created, domain };
}

/** Never lets a lookup failure fail the contact save; the failure is logged. */
export async function linkContactToCompanyQuietly(db: Q, contactId: string): Promise<CompanyLink> {
  try {
    return await linkContactToCompanyByEmail(db, contactId);
  } catch (err) {
    console.warn("[crm] company_from_email_failed", { contactId, message: (err as Error)?.message });
    return null;
  }
}
