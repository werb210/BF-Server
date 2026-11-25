// BF_SERVER_SHARED_CONTACTS_v1 (2026-11-24) - the shared list of brokers, lenders and banks behind every silo.
// A list (companies and the people at them) is loaded once: firms are matched by website domain (else name and country),
// people by email (else name at the same firm). Each person is then sent to the silos the routing table picks:
//   KS  Keystone prospects and call list (KS-Ops outreach import, with the consent basis for their country), and the KS CRM
//   BI  Boreal Risk Management (PGI) broker and lender lists (BI-Server list import)
//   BF  the Boreal Financial CRM (silo BF contacts, tagged; records only) - lenders and banks only
// Quebec is left out of PGI (the program is not available to Quebec residents). Nothing is emailed or enrolled here.
import type { Pool, PoolClient } from "pg";
import { signServiceToken } from "../../auth/serviceTokens.js";

type Q = Pick<Pool | PoolClient, "query">;
export type Brand = "BF" | "BI" | "KS";
export type Kind = "broker" | "lender" | "bank";
export const KINDS: readonly Kind[] = ["broker", "lender", "bank"];

export type InCompany = {
  name?: unknown; website?: unknown; phone?: unknown; address_street?: unknown; address_city?: unknown;
  address_state?: unknown; address_country?: unknown; kind?: unknown; custom_fields?: unknown; tags?: unknown;
};
export type InContact = {
  name?: unknown; company_name?: unknown; job_title?: unknown; email?: unknown; phone?: unknown;
  address_state?: unknown; address_country?: unknown; kind?: unknown; custom_fields?: unknown; tags?: unknown;
};

const text = (v: unknown, max = 300): string | null => {
  const t = String(v ?? "").trim().slice(0, max);
  return t ? t : null;
};
export function countryCode(v: unknown): string | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["ca", "can", "cdn", "canada"].includes(s)) return "CA";
  if (["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"].includes(s)) return "US";
  return s.toUpperCase().slice(0, 8);
}
const QC = new Set(["QC", "QUEBEC", "QUÉBEC", "PQ"]);
export const isQuebec = (region: unknown) => QC.has(String(region ?? "").trim().toUpperCase());
export function nameKey(v: unknown): string {
  return String(v ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/\b(inc|ltd|llc|corp|corporation|limited|co|the)\b\.?/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
const FREE_MAIL = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "live.com", "aol.com", "shaw.ca", "telus.net"]);
export function domainOf(website: unknown, email?: unknown): string | null {
  const w = String(website ?? "").trim().toLowerCase();
  if (w) {
    const host = w.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0] ?? "";
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return host;
  }
  const d = String(email ?? "").trim().toLowerCase().split("@")[1] ?? "";
  return d && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) && !FREE_MAIL.has(d) ? d : null;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const cleanEmail = (v: unknown): string | null => {
  const e = String(v ?? "").trim().toLowerCase();
  return EMAIL_RE.test(e) ? e.slice(0, 320) : null;
};
export function kindOf(v: unknown, fallback: Kind): Kind {
  const s = String(v ?? "").trim().toLowerCase();
  if (s.includes("bank")) return "bank";
  if (s.includes("lender") || s.includes("credit union")) return "lender";
  if (s.includes("broker")) return "broker";
  return fallback;
}

/** The default routing table (Shared Contact List design; Todd 2026-11-24: no brokers in the Boreal Financial CRM, every
 *  lender and bank in it). Brokers go to Keystone and PGI; lenders and banks to PGI and the Boreal Financial CRM. */
export function defaultBrands(kind: Kind, country: string | null, region: string | null): Brand[] {
  const out: Brand[] = [];
  const ca = country === "CA", us = country === "US";
  const pgi = (ca && !isQuebec(region)) || us;
  if (kind === "broker") {
    if (ca || us) out.push("KS");
    if (pgi) out.push("BI");
  } else {
    if (pgi) out.push("BI");
    out.push("BF");
  }
  return out;
}
/** The routing for one person: the list's override (only brands that also make sense for them), else the default. */
export function brandsFor(kind: Kind, country: string | null, region: string | null, only?: Brand[] | null): Brand[] {
  const def = defaultBrands(kind, country, region);
  if (!only || !only.length) return def;
  return def.filter((b) => only.includes(b));
}
/** The consent basis we record when a list is loaded: a published business email in Canada, a US business contact. */
export function consentFor(country: string | null, listName: string): { consent_type: string; consent_source: string } | null {
  if (country === "CA") return { consent_type: "implied_publication", consent_source: `Business email published by the firm (${listName})` };
  if (country === "US") return { consent_type: "us_opt_out", consent_source: `US business contact, CAN-SPAM (${listName})` };
  return null;
}

export type Row = {
  company: string; domain: string | null; website: string | null; kind: Kind; country: string | null; region: string | null;
  city: string | null; phone: string | null; address: string | null; research: Record<string, unknown>;
  person: { name: string | null; email: string | null; phone: string | null; title: string | null; research: Record<string, unknown> } | null;
};

/** Companies and contacts as one row per person (plus one row per firm with nobody named). */
export function toRows(companies: InCompany[], contacts: InContact[], listKind: Kind): { rows: Row[]; skipped: Array<{ row: number; error: string }> } {
  const byName = new Map<string, InCompany>();
  for (const c of companies) { const n = text(c.name, 200); if (n) byName.set(nameKey(n), c); }
  const rows: Row[] = [], skipped: Array<{ row: number; error: string }> = [], named = new Set<string>();
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  contacts.forEach((p, i) => {
    const company = text(p.company_name, 200);
    if (!company) { skipped.push({ row: i + 1, error: "No company name." }); return; }
    const c = byName.get(nameKey(company)) ?? {};
    const rawEmail = text(p.email, 320);
    const email = cleanEmail(rawEmail);
    if (rawEmail && !email) { skipped.push({ row: i + 1, error: `"${rawEmail}" is not an email address.` }); return; }
    const country = countryCode(p.address_country ?? c.address_country);
    named.add(nameKey(company));
    rows.push({
      company, website: text(c.website), domain: domainOf(c.website, email), kind: kindOf(p.kind ?? c.kind, listKind), country,
      region: text(p.address_state ?? c.address_state, 60), city: text(c.address_city, 120), phone: text(c.phone, 40),
      address: text(c.address_street, 300), research: obj(c.custom_fields),
      person: { name: text(p.name, 200), email, phone: text(p.phone, 40), title: text(p.job_title, 200), research: obj(p.custom_fields) },
    });
  });
  for (const c of companies) {
    const n = text(c.name, 200);
    if (!n || named.has(nameKey(n))) continue;
    rows.push({
      company: n, website: text(c.website), domain: domainOf(c.website), kind: kindOf(c.kind, listKind), country: countryCode(c.address_country),
      region: text(c.address_state, 60), city: text(c.address_city, 120), phone: text(c.phone, 40), address: text(c.address_street, 300),
      research: obj(c.custom_fields), person: null,
    });
  }
  return { rows, skipped };
}

export async function upsertOrg(db: Q, r: Row, listName: string): Promise<string> {
  const found = r.domain
    ? (await db.query(`SELECT id FROM directory_orgs WHERE lower(domain) = lower($1) LIMIT 1`, [r.domain])).rows[0]
    : (await db.query(`SELECT id FROM directory_orgs WHERE name_key = $1 AND coalesce(country, '') = coalesce($2, '') LIMIT 1`, [nameKey(r.company), r.country])).rows[0];
  if (found) {
    await db.query(
      `UPDATE directory_orgs SET website = coalesce(website, $2), domain = coalesce(domain, $3), country = coalesce(country, $4),
              region = coalesce(region, $5), city = coalesce(city, $6), phone = coalesce(phone, $7), address = coalesce(address, $8),
              research = research || $9::jsonb, sources = CASE WHEN $10 = ANY(sources) THEN sources ELSE sources || $10 END, updated_at = now()
        WHERE id = $1`,
      [found.id, r.website, r.domain, r.country, r.region, r.city, r.phone, r.address, JSON.stringify(r.research), listName],
    );
    return String(found.id);
  }
  const ins = await db.query(
    `INSERT INTO directory_orgs (name, name_key, domain, kind, country, region, city, website, phone, address, research, sources)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, ARRAY[$12]) RETURNING id`,
    [r.company, nameKey(r.company), r.domain, r.kind, r.country, r.region, r.city, r.website, r.phone, r.address, JSON.stringify(r.research), listName],
  );
  return String(ins.rows[0].id);
}

export async function upsertPerson(db: Q, orgId: string, r: Row, listName: string): Promise<{ id: string; created: boolean }> {
  const p = r.person!;
  const found = p.email
    ? (await db.query(`SELECT id FROM directory_people WHERE lower(email) = $1 LIMIT 1`, [p.email])).rows[0]
    : (await db.query(`SELECT id FROM directory_people WHERE org_id = $1 AND name_key = $2 AND email IS NULL LIMIT 1`, [orgId, nameKey(p.name)])).rows[0];
  if (found) {
    await db.query(
      `UPDATE directory_people SET org_id = coalesce(org_id, $2), name = coalesce(name, $3), phone = coalesce(phone, $4), title = coalesce($5, title),
              country = coalesce(country, $6), region = coalesce(region, $7), research = research || $8::jsonb,
              sources = CASE WHEN $9 = ANY(sources) THEN sources ELSE sources || $9 END, updated_at = now()
        WHERE id = $1`,
      [found.id, orgId, p.name, p.phone, p.title, r.country, r.region, JSON.stringify(p.research), listName],
    );
    return { id: String(found.id), created: false };
  }
  const ins = await db.query(
    `INSERT INTO directory_people (org_id, name, name_key, email, phone, title, kind, country, region, research, sources)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, ARRAY[$11]) RETURNING id`,
    [orgId, p.name, nameKey(p.name), p.email, p.phone, p.title, r.kind, r.country, r.region, JSON.stringify(p.research), listName],
  );
  return { id: String(ins.rows[0].id), created: true };
}

async function markBrand(db: Q, personId: string, brand: Brand, consent: { consent_type: string; consent_source: string } | null, siloId: string | null) {
  await db.query(
    `INSERT INTO directory_brand_status (person_id, brand, status, consent_basis, consent_source, silo_record_id)
     VALUES ($1, $2, 'loaded', $3, $4, $5)
     ON CONFLICT (person_id, brand) DO UPDATE SET consent_basis = coalesce(directory_brand_status.consent_basis, EXCLUDED.consent_basis),
       consent_source = coalesce(directory_brand_status.consent_source, EXCLUDED.consent_source),
       silo_record_id = coalesce(EXCLUDED.silo_record_id, directory_brand_status.silo_record_id), updated_at = now()`,
    [personId, brand, consent?.consent_type ?? null, consent?.consent_source ?? null, siloId],
  );
}

/** A silo BF CRM contact for this person (found by email, else created), tagged with the list. Records only. */
async function upsertBfContact(db: Q, r: Row, listTag: string): Promise<string | null> {
  const p = r.person;
  if (!p?.email) return null;
  const tag = r.kind === "broker" ? "referral partner" : "lender contact";
  const tags = [tag, r.kind, listTag];
  const found = (await db.query(`SELECT id FROM contacts WHERE silo = 'BF' AND lower(email) = $1 AND merged_into_id IS NULL LIMIT 1`, [p.email])).rows[0];
  if (found) {
    await db.query(
      `UPDATE contacts SET tags = (SELECT array_agg(DISTINCT t) FROM unnest(coalesce(tags, '{}') || $2::text[]) t),
              company_name = coalesce(company_name, $3), job_title = coalesce(job_title, $4), phone = coalesce(phone, $5),
              address_state = coalesce(address_state, $6), address_country = coalesce(address_country, $7), updated_at = now()
        WHERE id = $1`,
      [found.id, tags, r.company, p.title, p.phone, r.region, r.country],
    );
    return String(found.id);
  }
  const [first, ...rest] = String(p.name ?? "").split(/\s+/);
  const ins = await db.query(
    `INSERT INTO contacts (id, name, first_name, last_name, email, phone, company_name, job_title, address_state, address_country, tags, silo, role, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], 'BF', 'other', 'prospect') RETURNING id`,
    [p.name, first || null, rest.join(" ") || null, p.email, p.phone, r.company, p.title, r.region, r.country, tags],
  );
  return String(ins.rows[0].id);
}

/** BF_SERVER_KS_CRM_FROM_LISTS_v1 - Keystone's people now live in the KS CRM (silo KS companies and contacts), where
 *  Keystone email flows find them. Each Keystone row also lands there: the firm (by name) and, with an email, the
 *  person (by email), tagged with the list. Records only - nobody is emailed; flows still skip anyone suppressed. */
async function upsertKsCrm(db: Q, r: Row, listTag: string): Promise<string | null> {
  const tags = ["broker", listTag];
  let companyId: string | null = null;
  if (r.company) {
    const co = (await db.query(`SELECT id FROM companies WHERE silo = 'KS' AND lower(name) = lower($1) LIMIT 1`, [r.company])).rows[0];
    if (co) {
      companyId = String(co.id);
      await db.query(
        `UPDATE companies SET website = coalesce(website, $2), phone = coalesce(phone, $3), address_city = coalesce(address_city, $4),
                address_state = coalesce(address_state, $5), address_country = coalesce(address_country, $6),
                tags = (SELECT array_agg(DISTINCT t) FROM unnest(coalesce(tags, '{}') || $7::text[]) t), updated_at = now()
          WHERE id = $1`,
        [companyId, r.website, r.phone, r.city, r.region, r.country, tags],
      );
    } else {
      companyId = String((await db.query(
        `INSERT INTO companies (id, name, website, phone, address_street, address_city, address_state, address_country, tags, silo)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::text[], 'KS') RETURNING id`,
        [r.company, r.website, r.phone, r.address, r.city, r.region, r.country, tags],
      )).rows[0].id);
    }
  }
  const p = r.person;
  if (!p?.email) return null;
  const found = (await db.query(`SELECT id FROM contacts WHERE silo = 'KS' AND lower(email) = $1 AND merged_into_id IS NULL LIMIT 1`, [p.email])).rows[0];
  if (found) {
    await db.query(
      `UPDATE contacts SET tags = (SELECT array_agg(DISTINCT t) FROM unnest(coalesce(tags, '{}') || $2::text[]) t),
              company_name = coalesce(company_name, $3), company_id = coalesce(company_id, $4::uuid), job_title = coalesce(job_title, $5),
              phone = coalesce(phone, $6), address_state = coalesce(address_state, $7), address_country = coalesce(address_country, $8), updated_at = now()
        WHERE id = $1`,
      [found.id, tags, r.company, companyId, p.title, p.phone, r.region, r.country],
    );
    return String(found.id);
  }
  const [first, ...rest] = String(p.name ?? "").split(/\s+/);
  const ins = await db.query(
    `INSERT INTO contacts (id, name, first_name, last_name, email, phone, company_name, company_id, job_title, address_state, address_country, tags, silo, role, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::uuid, $8, $9, $10, $11::text[], 'KS', 'other', 'prospect') RETURNING id`,
    [p.name, first || null, rest.join(" ") || null, p.email, p.phone, r.company, companyId, p.title, r.region, r.country, tags],
  );
  return String(ins.rows[0].id);
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
export type SiloDeps = { fetch: Fetcher; biUrl: string; ksOpsUrl: string; staffToken: string | null };

/** Boreal Risk Management: the BI-Server list import (companies and people, tagged with the list). */
async function pushBi(deps: SiloDeps, rows: Row[], listTag: string) {
  if (!rows.length) return { sent: 0 };
  const companies = new Map<string, Record<string, unknown>>();
  const contacts: Record<string, unknown>[] = [];
  for (const r of rows) {
    if (!companies.has(r.company)) companies.set(r.company, {
      name: r.company, website: r.website, phone: r.phone, address_street: r.address, address_city: r.city, address_state: r.region,
      address_country: r.country, kind: r.kind === "broker" ? "broker" : "lender", tags: `${listTag}; ${r.kind}`, custom_fields: r.research,
    });
    if (r.person) contacts.push({
      name: r.person.name, company_name: r.company, job_title: r.person.title, email: r.person.email, phone: r.person.phone,
      address_state: r.region, address_country: r.country, tags: `${listTag}; ${r.kind}`, custom_fields: r.person.research,
    });
  }
  const res = await deps.fetch(`${deps.biUrl.replace(/\/+$/, "")}/api/v1/bi/crm/list-import`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${signServiceToken("bi-server", { source: "bf-server" })}` },
    body: JSON.stringify({ companies: [...companies.values()], contacts }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`BI list import answered ${res.status}`);
  return { sent: contacts.length, result: body };
}

/** Keystone: the KS-Ops outreach import (brokerages, people and their prospect records), one call per country so each
 *  gets its consent basis. KS-Ops only takes staff, so the staff member's own sign-in is exchanged for a KS-Ops token. */
async function pushKs(deps: SiloDeps, rows: Row[], listName: string) {
  if (!rows.length) return { sent: 0 };
  if (!deps.staffToken) throw new Error("Keystone needs the staff member's sign-in");
  const base = deps.ksOpsUrl.replace(/\/+$/, "");
  const ex = await deps.fetch(`${base}/api/ops/auth/exchange`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bfToken: deps.staffToken }),
  });
  const exBody = await ex.json().catch(() => null);
  const token = exBody?.token ?? exBody?.accessToken;
  if (!ex.ok || !token) throw new Error(`KS-Ops sign-in answered ${ex.status}`);
  const out: Record<string, unknown> = {};
  for (const cc of ["CA", "US"]) {
    const part = rows.filter((r) => r.country === cc);
    if (!part.length) continue;
    const res = await deps.fetch(`${base}/api/ops/outreach/import`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        consent: consentFor(cc, listName),
        rows: part.map((r) => ({
          company: r.company, website: r.website, country: r.country, province_state: r.region, city: r.city,
          contact_name: r.person?.name, title: r.person?.title, email: r.person?.email, direct_phone: r.person?.phone,
          firm_type: r.kind === "broker" ? undefined : r.kind,
        })),
      }),
    });
    out[cc] = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`KS-Ops import (${cc}) answered ${res.status}`);
  }
  return { sent: rows.length, result: out };
}

export type ImportInput = {
  list_name: string; kind: Kind; only?: Brand[] | null; companies: InCompany[]; contacts: InContact[]; created_by: string | null;
};

export async function importSharedList(db: Q, deps: SiloDeps, input: ImportInput) {
  const listName = input.list_name.trim().slice(0, 120);
  const listTag = listName.toLowerCase();
  const { rows, skipped } = toRows(input.companies, input.contacts, input.kind);
  const tally = { firms: new Set<string>(), people_added: 0, people_updated: 0, by_brand: { BF: 0, BI: 0, KS: 0 } as Record<Brand, number> };
  const toSilo: Record<Brand, Array<{ row: Row; personId: string | null }>> = { BF: [], BI: [], KS: [] };
  for (const r of rows) {
    const orgId = await upsertOrg(db, r, listName);
    tally.firms.add(orgId);
    let personId: string | null = null;
    if (r.person && (r.person.email || r.person.name)) {
      const p = await upsertPerson(db, orgId, r, listName);
      personId = p.id;
      p.created ? tally.people_added++ : tally.people_updated++;
    }
    for (const b of brandsFor(r.kind, r.country, r.region, input.only)) toSilo[b].push({ row: r, personId });
  }
  const silos: Record<Brand, unknown> = { BF: null, BI: null, KS: null };
  // Boreal Financial CRM: people with an email only (records, no emails).
  let bf = 0;
  for (const { row, personId } of toSilo.BF) {
    const id = await upsertBfContact(db, row, listTag);
    if (id && personId) { await markBrand(db, personId, "BF", null, id); bf++; }
  }
  silos.BF = { sent: bf };
  // BF_SERVER_KS_CRM_FROM_LISTS_v1 - Keystone rows into the KS CRM as well as KS-Ops (one failure never stops the rest).
  let ksCrm = 0, ksCrmErrors = 0;
  for (const { row } of toSilo.KS) {
    try { if (await upsertKsCrm(db, row, listTag)) ksCrm++; }
    catch (e) { ksCrmErrors++; console.error(`[shared-contacts] KS CRM upsert failed for ${row.company}: ${(e as Error).message}`); }
  }
  for (const brand of ["BI", "KS"] as const) {
    const items = toSilo[brand];
    try {
      silos[brand] = brand === "BI" ? await pushBi(deps, items.map((x) => x.row), listTag) : await pushKs(deps, items.map((x) => x.row), listName);
      for (const { row, personId } of items) if (personId && row.person?.email) await markBrand(db, personId, brand, consentFor(row.country, listName), null);
    } catch (e) {
      console.error(`[shared-contacts] ${brand} push failed: ${(e as Error).message}`);
      silos[brand] = { error: (e as Error).message };
    }
  }
  for (const b of ["BF", "BI", "KS"] as const) tally.by_brand[b] = toSilo[b].filter((x) => x.row.person?.email).length;
  const result = {
    rows: rows.length, firms: tally.firms.size, people_added: tally.people_added, people_updated: tally.people_updated,
    routed: tally.by_brand, silos, skipped, ks_crm: { people: ksCrm, errors: ksCrmErrors },
  };
  await db.query(
    `INSERT INTO directory_imports (list_name, kind, row_count, routing, result, created_by) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
    [listName, input.kind, rows.length, JSON.stringify({ only: input.only ?? null }), JSON.stringify(result), input.created_by],
  );
  return result;
}

/** BF_SHARED_CONTACTS_STAGE3_v1 - what an import would do, without writing anything: rows read, skipped, how many
 *  people are new or already on file, and how many go to each silo. */
export async function previewSharedList(db: Q, input: Omit<ImportInput, "created_by">) {
  const { rows, skipped } = toRows(input.companies, input.contacts, input.kind);
  const emails = [...new Set(rows.map((r) => r.person?.email).filter((e): e is string => !!e))];
  const known = emails.length
    ? new Set((await db.query(`SELECT lower(email) AS email FROM directory_people WHERE lower(email) = ANY($1::text[])`, [emails])).rows.map((r: any) => String(r.email)))
    : new Set<string>();
  const routed: Record<Brand, number> = { BF: 0, BI: 0, KS: 0 };
  for (const r of rows) if (r.person?.email) for (const b of brandsFor(r.kind, r.country, r.region, input.only)) routed[b]++;
  const firms = new Set(rows.map((r) => r.domain ?? nameKey(r.company)));
  return {
    rows: rows.length, firms: firms.size, with_email: emails.length,
    people_new: emails.filter((e) => !known.has(e)).length, people_on_file: emails.filter((e) => known.has(e)).length,
    routed, skipped,
  };
}

/** One person: their firm, every brand's state, and where they came from. */
export async function getPerson(db: Q, id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const r = await db.query(
    `SELECT p.id, p.name, p.email, p.phone, p.title, p.kind, p.country, p.region, p.sources, p.research, p.all_brands_opt_out, p.bad_address,
            p.created_at, p.updated_at, o.id AS firm_id, o.name AS firm, o.domain, o.website, o.phone AS firm_phone, o.city, o.address, o.research AS firm_research
       FROM directory_people p LEFT JOIN directory_orgs o ON o.id = p.org_id WHERE p.id = $1`,
    [id],
  );
  if (!r.rows[0]) return null;
  const b = await db.query(
    `SELECT brand, status, consent_basis, consent_source, silo_record_id, last_activity, last_activity_at, updated_at
       FROM directory_brand_status WHERE person_id = $1 ORDER BY brand`,
    [id],
  );
  return { ...r.rows[0], brands: b.rows };
}

/** The lists people came from, for the filter. */
export async function listSources(db: Q): Promise<Array<{ source: string; people: number }>> {
  const r = await db.query(`SELECT src AS source, count(*)::int AS people FROM directory_people, unnest(sources) src GROUP BY src ORDER BY src`);
  return r.rows.map((x: any) => ({ source: String(x.source), people: Number(x.people) }));
}

/** People in the shared list, with where they are in each brand. */
export async function listPeople(db: Q, f: { kind?: string; country?: string; region?: string; brand?: string; status?: string; not_brand?: string; source?: string; q?: string; limit?: number; offset?: number }) {
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("$?", `$${params.length}`)); };
  if (f.kind && (KINDS as readonly string[]).includes(f.kind)) add(`p.kind = $?`, f.kind);
  if (f.country) add(`p.country = $?`, countryCode(f.country));
  if (f.brand && ["BF", "BI", "KS"].includes(f.brand)) {
    if (f.status) { params.push(f.brand, f.status); where.push(`EXISTS (SELECT 1 FROM directory_brand_status s WHERE s.person_id = p.id AND s.brand = $${params.length - 1} AND s.status = $${params.length})`); }
    else add(`EXISTS (SELECT 1 FROM directory_brand_status s WHERE s.person_id = p.id AND s.brand = $?)`, f.brand);
  }
  if (f.region) add(`upper(p.region) = upper($?)`, String(f.region).slice(0, 60));
  if (f.source) add(`$? = ANY(p.sources)`, String(f.source).slice(0, 120));
  if (f.not_brand && ["BF", "BI", "KS"].includes(f.not_brand)) add(`NOT EXISTS (SELECT 1 FROM directory_brand_status s WHERE s.person_id = p.id AND s.brand = $?)`, f.not_brand);
  if (f.q) { params.push(`%${String(f.q).slice(0, 100)}%`); const i = params.length; where.push(`(p.name ILIKE $${i} OR p.email ILIKE $${i} OR o.name ILIKE $${i})`); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 1000), offset = Math.max(Number(f.offset) || 0, 0);
  const total = Number((await db.query(`SELECT count(*)::int AS n FROM directory_people p LEFT JOIN directory_orgs o ON o.id = p.org_id ${w}`, params)).rows[0]?.n ?? 0);
  const r = await db.query(
    `SELECT p.id, p.name, p.email, p.phone, p.title, p.kind, p.country, p.region, p.all_brands_opt_out, p.sources, o.name AS firm, o.domain,
            coalesce((SELECT jsonb_object_agg(s.brand, jsonb_build_object('status', s.status, 'last_activity', s.last_activity, 'at', s.last_activity_at))
                        FROM directory_brand_status s WHERE s.person_id = p.id), '{}'::jsonb) AS brands
       FROM directory_people p LEFT JOIN directory_orgs o ON o.id = p.org_id ${w}
      ORDER BY o.name NULLS LAST, p.name LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return { total, people: r.rows };
}
