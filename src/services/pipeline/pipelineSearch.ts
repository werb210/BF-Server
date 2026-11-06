// BF_SERVER_v906_PIPELINE_SEARCH - the Pipeline page's search box. The board loads at most 500 cards, so the search
// runs on the server across every stage: business name (application name, legal name, company), the applicant or any
// other contact on the file (name, email, phone digits) and the application id.

/** Escapes LIKE wildcards so a typed "%" or "_" matches itself. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Digits to match a phone against: at least 4, and the last 10 (so "+1 403..." and "403..." both match). */
export function phoneDigits(text: string): string | null {
  const digits = text.replace(/\D+/g, "");
  if (digits.length < 4) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * Adds the search condition for `q` to `values` and returns the SQL (or null when q is blank). The query it joins must
 * alias applications as `a` and companies as `c`.
 */
export function pipelineSearchClause(qRaw: unknown, values: unknown[]): string | null {
  const q = String(qRaw ?? "").trim().slice(0, 100);
  if (!q) return null;
  values.push(`%${escapeLike(q)}%`);
  const p = `$${values.length}`;
  values.push(phoneDigits(q));
  const d = `$${values.length}::text`;
  const contactMatch = (alias: string) =>
    `(${alias}.name ILIKE ${p} OR ${alias}.email ILIKE ${p} OR (${d} IS NOT NULL AND regexp_replace(COALESCE(${alias}.phone, ''), '[^0-9]', '', 'g') LIKE '%' || ${d} || '%'))`;
  return `(
    a.id::text ILIKE ${p}
    OR COALESCE(a.name, '') ILIKE ${p}
    OR COALESCE(a.business_legal_name, '') ILIKE ${p}
    OR COALESCE(c.name, '') ILIKE ${p}
    OR EXISTS (SELECT 1 FROM contacts sc WHERE sc.id::text = a.contact_id::text AND ${contactMatch("sc")})
    OR EXISTS (SELECT 1 FROM application_contacts sac JOIN contacts sc2 ON sc2.id = sac.contact_id
                WHERE sac.application_id::text = a.id::text AND ${contactMatch("sc2")})
  )`;
}
