// BF_SERVER_v925_COMPANY_FROM_EMAIL - a contact with a work email but no company gets one: the company whose
// domain/website matches the email domain, else a new company named from the contact's own company name or from
// the domain (kathrina@signnow.com -> "Signnow", domain signnow.com). The contact is linked, so the Company column and
// the contact card show it. Free mail (gmail, outlook, shaw.ca, ...) and disposable domains are never used.
// Runs every 10 minutes for contacts created any way (forms, imports, inbox, Maya), and once at start-up.
import type { Pool } from "pg";
import { FREE_EMAIL_DOMAINS } from "../modules/crmUnify/webSource.js";
import { DISPOSABLE_DOMAINS } from "../fraud/checks/disposableDomains.js";
import { claimedTick } from "../workers/claim.js";

type Q = Pick<Pool, "query">;

const SKIP = [...new Set([...FREE_EMAIL_DOMAINS, ...DISPOSABLE_DOMAINS].map((d) => d.toLowerCase()))];
const STOP = new Set(["example.com", "example.org", "test.com", "localhost"]);

export function emailDomain(email: unknown): string | null {
  const m = /@([a-z0-9.-]+\.[a-z]{2,})\s*$/i.exec(String(email ?? "").trim());
  if (!m) return null;
  const d = m[1]!.toLowerCase().replace(/^(mail|email|www)\./, "");
  return SKIP.includes(d) || STOP.has(d) ? null : d;
}

/** "signnow.com" -> "Signnow"; "allen-capital.co.uk" -> "Allen Capital"; "firstnational.ca" -> "Firstnational". */
export function companyNameFromDomain(domain: string): string {
  const parts = domain.toLowerCase().split(".");
  // drop the TLD, and a second-level like co / com / org / gc in co.uk, com.au, gc.ca
  let core = parts.length > 2 && /^(co|com|org|net|gov|gc|ac)$/.test(parts[parts.length - 2]!) ? parts[parts.length - 3]! : parts[parts.length - 2] ?? parts[0]!;
  core = core.replace(/[_-]+/g, " ").trim();
  return core.split(" ").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

const HOST_SQL = (col: string) => `lower(regexp_replace(regexp_replace(coalesce(${col}, ''), '^https?://(www\\.)?', ''), '[/:?#].*$', ''))`;

export async function linkCompaniesFromEmail(db: Q, limit = 500): Promise<{ linked: number; created: number }> {
  const r = await db.query(
    `SELECT c.id::text AS id, c.silo, c.email, nullif(btrim(c.company_name), '') AS company_name
       FROM contacts c
      WHERE c.company_id IS NULL AND c.email LIKE '%_@_%.__%'
        AND c.merged_into_id IS NULL AND coalesce(c.status, 'active') <> 'archived'
        AND lower(split_part(c.email, '@', 2)) <> ALL($1::text[])
      ORDER BY c.created_at DESC
      LIMIT $2`,
    [SKIP, limit],
  );
  let linked = 0; let created = 0;
  for (const c of r.rows as Array<{ id: string; silo: string; email: string; company_name: string | null }>) {
    const domain = emailDomain(c.email);
    if (!domain) continue;
    const found = await db.query(
      `SELECT id::text AS id, coalesce(name, legal_name) AS name FROM companies
        WHERE silo = $1 AND (lower(coalesce(domain, '')) = $2 OR ${HOST_SQL("website")} = $2
              OR ($3::text IS NOT NULL AND lower(btrim(coalesce(name, ''))) = lower($3)))
        ORDER BY (lower(coalesce(domain, '')) = $2 OR ${HOST_SQL("website")} = $2) DESC, created_at ASC
        LIMIT 1`,
      [c.silo, domain, c.company_name],
    );
    let company = found.rows[0] as { id: string; name: string } | undefined;
    if (!company) {
      const name = c.company_name ?? companyNameFromDomain(domain);
      const ins = await db.query(
        `INSERT INTO companies (id, name, domain, website, silo, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), now()) RETURNING id::text AS id, name`,
        [name, domain, `https://${domain}`, c.silo],
      );
      company = ins.rows[0];
      created += 1;
    }
    if (!company) continue;
    const up = await db.query(
      `UPDATE contacts SET company_id = $2::uuid, company_name = coalesce(nullif(btrim(company_name), ''), $3), updated_at = now()
        WHERE id = $1::uuid AND company_id IS NULL`,
      [c.id, company.id, company.name],
    );
    linked += up.rowCount ?? 0;
  }
  return { linked, created };
}

export function startCompanyFromEmailWorker(pool: Pool): { stop: () => void } {
  const tick = claimedTick("company_from_email", async () => {
    try {
      const out = await linkCompaniesFromEmail(pool);
      if (out.linked || out.created) console.log(JSON.stringify({ event: "company_from_email", ...out }));
    } catch (e) {
      console.error("[company-from-email] tick failed", e instanceof Error ? e.message : e);
    }
  });
  const timer = setInterval(() => { void tick(); }, 10 * 60 * 1000);
  void tick();
  return { stop: () => clearInterval(timer) };
}
