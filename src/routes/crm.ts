// BF_SERVER_BLOCK_v122a_SILO_SOURCE_FIXES_v1 — silo from getSilo(res) at every read site
import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { respondOk } from "../utils/respondOk.js";
import { handleListCrmTimeline } from "../modules/crm/timeline.controller.js";
import { SupportController } from "../modules/support/support.controller.js";
import { pool } from "../db.js";
import { bumpBiOutreachToContacted } from "../services/biOutreach.js"; // BF_SERVER_BLOCK_v344_BI_OUTREACH_AUTOADVANCE_v1
import { getSilo, resolveSiloFromRequest } from "../middleware/silo.js";
import { createContact } from "../services/contacts.js";
import notesRoutes from "./crm/notes.js";
import tasksRoutes from "./crm/tasks.js";
import emailsRoutes from "./crm/emails.js";
import meetingsRoutes from "./crm/meetings.js";
import callsActivityRoutes from "./crm/calls.js";
import timelineRoutes from "./crm/timeline.js";
import sharedMailboxesRoutes from "./crm/sharedMailboxes.js";
import inboxRoutes from "./crm/inbox.js";
import voicemailsRoutes from "./crm/voicemails.js"; // BF_SERVER_BLOCK_v830_VOICEMAILS_LIST

const router = Router();

// Public website lead intake endpoint
router.post("/web-leads", SupportController.createWebLead);

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.CRM_READ]));

// BF_SERVER_BLOCK_BI_ROUND7_OPS_DASHBOARD_v1
router.get("/leads", safeHandler(async (_req: any, res: any) => {
  const result = await pool.query(`
    SELECT
      id,
      company_name,
      full_name,
      phone,
      email,
      industry,
      years_in_business,
      monthly_revenue,
      annual_revenue,
      ar_outstanding,
      source,
      tags,
      created_at
    FROM crm_leads
    ORDER BY created_at DESC
    LIMIT 500
  `).catch((err: any) => {
    console.warn("crm.leads.query_failed", {
      message: err?.message, code: err?.code,
    });
    return { rows: [] as any[] };
  });
  const leads = result.rows.map((r: any) => ({
    id: r.id,
    companyName: r.company_name ?? undefined,
    fullName: r.full_name ?? undefined,
    email: r.email ?? "",
    phone: r.phone ?? undefined,
    industry: r.industry ?? undefined,
    yearsInBusiness: r.years_in_business ?? undefined,
    monthlyRevenue: r.monthly_revenue ?? undefined,
    annualRevenue: r.annual_revenue ?? undefined,
    arBalance: r.ar_outstanding ?? undefined,
    source: r.source ?? "website",
    status: "new",
    tags: Array.isArray(r.tags) ? r.tags : [],
    createdAt: r.created_at,
  }));
  return res.status(200).json(leads);
}));
// BF_SERVER_BLOCK_v152_CRM_WRITE_CAPABILITY_v1 — CRM_WRITE required
// for any mutating handler. The router-level CRM_READ stays for GET.
const requireCrmWrite = requireCapability([CAPABILITIES.CRM_WRITE]);


router.get("/contacts/:id/companies", safeHandler(async (req: any, res: any) => {
  try {
    const { rows } = await pool.query(
      `SELECT *
       FROM companies
       WHERE id IN (
         SELECT company_id
         FROM contacts
         WHERE id = $1
       )
       OR name = (
         SELECT company_name
         FROM contacts
         WHERE id = $1
         LIMIT 1
       )`,
      [req.params.id]
    );

    return res.json(rows);
  } catch {
    return res.json([]);
  }
}));

router.get("/contacts/:id/applications", safeHandler(async (req: any, res: any) => {
  // BF_SERVER_BLOCK_v302_CRM_CONTACT_APPLICATIONS_SCHEMA_FIX_v1
  // The CRM contact-drawer "Applications" sub-section consumes this
  // endpoint and renders { id, stage, contactId } per ContactDetailsDrawer
  // -> fetchApplications. The old query referenced two columns that do not
  // exist on the applications table: `stage` (the real columns are
  // pipeline_state / current_stage / status) and `archived` (only
  // offers.is_archived exists — applications has no archived flag at all).
  // Postgres rejected the query with "column does not exist" and the
  // catch-all swallowed it, so the sub-section silently rendered as empty
  // for every contact regardless of how many applications they had.
  // Use the canonical columns and surface the catch failures via warn so
  // the next schema drift is visible.
  try {
    const { rows } = await pool.query(
      `SELECT id::text                                          AS id,
              coalesce(pipeline_state, current_stage, status, '') AS stage,
              contact_id::text                                    AS "contactId"
         FROM applications
        WHERE contact_id::text = $1
        ORDER BY created_at DESC`,
      [req.params.id]
    );

    return res.json(rows);
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.warn('crm.contact_applications.query_failed', {
      contactId: req.params.id,
      message: err?.message,
      code: err?.code,
    });
    return res.json([]);
  }
}));

router.get("/", safeHandler((_req: any, res: any) => {
  respondOk(res, {
    customers: [],
    contacts: [],
    totalCustomers: 0,
    totalContacts: 0,
  });
}));

router.get("/customers", safeHandler((req: any, res: any) => {
  const page = Number(req.query.page) || 1;
  const pageSize = Number(req.query.pageSize) || 25;
  respondOk(
    res,
    {
      customers: [],
      total: 0,
    },
    {
      page,
      pageSize,
    }
  );
}));

router.get("/contacts", safeHandler(async (req: any, res: any) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Number(req.query.pageSize) || 200, 500);
  const offset = (page - 1) * pageSize;
  // v635: accept both `search` (server original) and `q` (frontend ContactsPage). Companies route uses `q`; this aligns Contacts.
  const search = (typeof req.query.search === "string" && req.query.search.trim())
    || (typeof req.query.q === "string" && req.query.q.trim())
    || "";
  const ownerId = typeof req.query.owner_id === "string" ? req.query.owner_id.trim() : "";
  const leadStatus = typeof req.query.lead_status === "string" ? req.query.lead_status.trim() : "";
  const hasActiveApplications = req.query.has_active_applications === "true";

  // BF_SERVER_BLOCK_v123_READINESS_SQL_AND_SILO_AUTH_RESOLUTION_v1 — re-resolve silo
  // from req.user (siloMiddleware ran before requireAuth and stamped BF default).
  const silo = resolveSiloFromRequest(req);

  const contactsColumnCheck = await pool.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'contacts'
       AND column_name = ANY($1::text[])`,
    [["company_name", "company_id", "lead_status", "tags", "owner_id"]]
  ).catch(() => ({ rows: [] as Array<{ column_name: string }> }));
  const availableColumns = new Set(contactsColumnCheck.rows.map((row) => row.column_name));
  const hasCompanyName = availableColumns.has("company_name");
  const hasCompanyId = availableColumns.has("company_id");
  const hasLeadStatus = availableColumns.has("lead_status");
  const hasTags = availableColumns.has("tags");
  const hasOwnerId = availableColumns.has("owner_id");
  // BF_SERVER_BLOCK_v81_CONTACTS_SORT — accept ?sort=col:dir from the portal.
  // Whitelist columns; unknown sort falls back to created_at desc.
  const SORT_COLS = new Set(["name", "company_name", "lead_status", "owner_name", "created_at"]);
  const rawSort = typeof req.query.sort === "string" ? req.query.sort : "";
  const [sortCol, sortDir] = rawSort.split(":");
  const orderCol = SORT_COLS.has(sortCol) ? sortCol : "created_at";
  const orderDir = sortDir && sortDir.toLowerCase() === "asc" ? "ASC" : "DESC";
  // company_name and owner_name require their joined table aliases; map them.
  const orderColExpr =
    orderCol === "company_name" ? "co.name"
    : orderCol === "owner_name" ? "u.first_name"
    : `c.${orderCol}`;

  const values: unknown[] = [silo];
  const where: string[] = ["c.silo = $1"];

  if (ownerId) {
    if (!hasOwnerId) {
      where.push("1 = 0");
    } else {
      values.push(ownerId);
      where.push(`c.owner_id = $${values.length}`);
    }
  }
  if (leadStatus) {
    if (!hasLeadStatus) {
      values.push(leadStatus);
      where.push(`$${values.length} = 'New'`);
    } else {
      values.push(leadStatus);
      where.push(`coalesce(c.lead_status, 'New') = $${values.length}`);
    }
  }
  // BF_SERVER_BLOCK_v805_TAG_FILTER — filter contacts by a single tag (e.g. "active"); case-insensitive.
  const tagFilter = typeof req.query.tag === "string" ? req.query.tag.trim().toLowerCase() : "";
  if (tagFilter && hasTags) {
    values.push(tagFilter);
    where.push(`EXISTS (SELECT 1 FROM unnest(coalesce(c.tags, '{}'::text[])) t WHERE lower(t) = $${values.length})`);
  }
  if (search) {
    values.push(`%${search}%`);
    const searchParts = [
      `c.name ILIKE $${values.length}`,
      `c.email ILIKE $${values.length}`,
      `c.phone ILIKE $${values.length}`,
    ];
    if (hasCompanyName) {
      searchParts.push(`coalesce(c.company_name, '') ILIKE $${values.length}`);
    }
    if (hasTags) {
      searchParts.push(`array_to_string(coalesce(c.tags, '{}'::text[]), ' ') ILIKE $${values.length}`);
    }
    if (hasLeadStatus) {
      searchParts.push(`coalesce(c.lead_status, 'New') ILIKE $${values.length}`);
    }
    if (hasOwnerId) {
      searchParts.push(`coalesce(u.first_name || ' ' || u.last_name, '') ILIKE $${values.length}`);
    }
    where.push(`(${searchParts.join(" OR ")})`);
  }
  if (hasActiveApplications) {
    where.push(`EXISTS (
      SELECT 1
      FROM applications a
      WHERE a.contact_id = c.id
        AND coalesce(a.archived, false) = false
    )`);
  }

  values.push(pageSize, offset);

  const sql = `SELECT
      c.id,
      c.name,
      c.first_name,
      c.last_name,
      c.email,
      c.phone,
      ${hasCompanyName ? "coalesce(c.company_name, '')" : "''::text"} AS company_name,
      ${hasCompanyId ? "c.company_id" : "NULL::uuid"} AS company_id,
      ${hasLeadStatus ? "coalesce(c.lead_status, 'New')" : "'New'::text"} AS lead_status,
      ${hasTags ? "coalesce(c.tags, '{}')" : "'{}'::text[]"} AS tags,
      ${hasOwnerId ? "c.owner_id" : "NULL::uuid"} AS owner_id,
      coalesce(u.first_name || ' ' || u.last_name, '') AS owner_name,
      c.created_at,
      c.silo
    FROM contacts c
    LEFT JOIN companies co ON ${hasCompanyId ? "c.company_id = co.id" : "false"}
    LEFT JOIN users u ON ${hasOwnerId ? "c.owner_id = u.id" : "false"}
    WHERE ${where.join(" AND ")}
    ORDER BY ${orderColExpr} ${orderDir} NULLS LAST, c.created_at DESC
    LIMIT $${values.length - 1} OFFSET $${values.length}`;

  const { rows } = await pool.query(sql, values);
  respondOk(res, rows, { page, pageSize });
}));

router.post("/contacts", requireCrmWrite, safeHandler(async (req: any, res: any) => {
  const {
    name,
    first_name,
    last_name,
    email,
    phone,
    dob,
    ssn,
    address_street,
    address_city,
    address_state,
    address_zip,
    address_country,
    ownership_percent,
    role,
    is_primary_applicant,
    company_id,
  } = req.body ?? {};
  let fname = String(first_name ?? "").trim();
  let lname = String(last_name ?? "").trim();
  const fullNameRaw = String(name ?? "").trim();
  if ((!fname || !lname) && fullNameRaw) {
    const parts = fullNameRaw.split(/\s+/).filter(Boolean);
    if (!fname) fname = parts[0] ?? "";
    if (!lname) lname = parts.slice(1).join(" ") || "Unknown";
  }
  if (!fname) return res.status(400).json({ error: { field: "first_name", message: "first_name is required" } });
  if (!lname) return res.status(400).json({ error: { field: "last_name", message: "last_name is required" } });
  if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(String(dob))) {
    return res.status(400).json({ error: { field: "dob", message: "dob must be yyyy-mm-dd" } });
  }
  const parsedOwnership = ownership_percent == null ? null : Number(ownership_percent);
  if (parsedOwnership != null && (Number.isNaN(parsedOwnership) || parsedOwnership < 0 || parsedOwnership > 100)) {
    return res.status(400).json({ error: { field: "ownership_percent", message: "ownership_percent must be between 0 and 100" } });
  }
  const validRoles = new Set(["applicant", "partner", "guarantor", "other", "unknown"]);
  const normalizedRole = String(role ?? "unknown").toLowerCase();
  if (!validRoles.has(normalizedRole)) {
    return res.status(400).json({ error: { field: "role", message: "invalid role" } });
  }
  if (company_id != null && !/^[0-9a-f-]{36}$/i.test(String(company_id))) {
    return res.status(400).json({ error: { field: "company_id", message: "company_id must be a UUID" } });
  }

  const silo = resolveSiloFromRequest(req);
  const ownerId = req.user?.id ?? req.user?.userId ?? null;
  const row = await createContact(pool, {
    first_name: fname,
    last_name: lname,
    email: email ?? null,
    phone: phone ?? null,
    dob: dob ?? null,
    ssn: ssn ? String(ssn) : null,
    address_street: address_street ?? null,
    address_city: address_city ?? null,
    address_state: address_state ?? null,
    address_zip: address_zip ?? null,
    address_country: address_country ?? null,
    ownership_percent: parsedOwnership,
    role: normalizedRole as "applicant" | "partner" | "guarantor" | "other" | "unknown",
    is_primary_applicant: is_primary_applicant === true,
    company_id: company_id ?? null,
    silo,
    owner_id: ownerId,
  });

  return res.status(201).json({ ok: true, data: row });
}));


// BF_SERVER_BLOCK_v759_CONTACT_CSV_IMPORT — bulk upsert from a CSV the portal
// parsed client-side. Dedupe by email within the silo: existing -> update with
// the new (non-empty) fields; new -> insert. Imported contacts are owned by the
// importing staff user; an existing contact's owner is filled only if unset.
router.post("/contacts/import", requireCrmWrite, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const ownerId = req.user?.id ?? req.user?.userId ?? null;
  const rows: any[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!Array.isArray(req.body?.rows)) {
    return res.status(400).json({ error: { field: "rows", message: "rows[] is required" } });
  }
  if (rows.length > 20000) {
    return res.status(400).json({ error: { field: "rows", message: "too many rows (max 20000)" } });
  }

  const colRes = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'contacts'`,
  );
  const cols = new Set<string>(colRes.rows.map((r: any) => r.column_name));
  const has = (c: string) => cols.has(c);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const raw of rows) {
      const r = raw ?? {};
      const email = String(r.email ?? "").trim();
      let fname = String(r.first_name ?? "").trim();
      let lname = String(r.last_name ?? "").trim();
      const full = String(r.name ?? "").trim();
      if ((!fname || !lname) && full) {
        const parts = full.split(/\s+/).filter(Boolean);
        if (!fname) fname = parts[0] ?? "";
        if (!lname) lname = parts.slice(1).join(" ");
      }
      if (!email && !fname && !lname) { skipped++; continue; }

      const phone = String(r.phone ?? "").trim() || null;
      const companyName = String(r.company_name ?? "").trim() || null;
      const jobTitle = String(r.job_title ?? "").trim() || null;
      const leadStatus = String(r.lead_status ?? "").trim() || null;
      const displayName = `${fname} ${lname}`.trim();

      let existingId: string | null = null;
      if (email) {
        const ex = await client.query(
          `SELECT id FROM contacts WHERE silo = $1 AND lower(email) = lower($2) LIMIT 1`,
          [silo, email],
        );
        existingId = ex.rows[0]?.id ?? null;
      }

      if (existingId) {
        const sets: string[] = [];
        const vals: any[] = [];
        let i = 1;
        const overwrite = (col: string, val: any) => {
          if (has(col) && val != null && val !== "") { sets.push(`${col} = $${i}`); vals.push(val); i++; }
        };
        overwrite("first_name", fname || null);
        overwrite("last_name", lname || null);
        overwrite("name", displayName || null);
        overwrite("phone", phone);
        overwrite("company_name", companyName);
        overwrite("job_title", jobTitle);
        overwrite("lead_status", leadStatus);
        if (has("owner_id") && ownerId) { sets.push(`owner_id = COALESCE(owner_id, $${i})`); vals.push(ownerId); i++; }
        if (has("updated_at")) { sets.push("updated_at = now()"); }
        if (!sets.length) { skipped++; continue; }
        vals.push(existingId);
        await client.query(`UPDATE contacts SET ${sets.join(", ")} WHERE id = $${i}`, vals);
        updated++;
      } else {
        const insCols: string[] = [];
        const ph: string[] = [];
        const vals: any[] = [];
        let i = 1;
        const add = (col: string, val: any) => {
          if (has(col)) { insCols.push(col); ph.push(`$${i}`); vals.push(val); i++; }
        };
        add("first_name", fname || "");
        add("last_name", lname || "");
        add("name", displayName || email || "");
        add("email", email || null);
        add("phone", phone);
        add("company_name", companyName);
        add("job_title", jobTitle);
        add("lead_status", leadStatus || "New");
        add("silo", silo);
        add("owner_id", ownerId);
        await client.query(
          `INSERT INTO contacts (${insCols.join(", ")}) VALUES (${ph.join(", ")})`,
          vals,
        );
        created++;
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return res.json({ ok: true, created, updated, skipped, total: rows.length });
}));

// BF_SERVER_CRM_COMPANY_IMPORT_ENDPOINT — upsert companies by name within silo. Mirrors /contacts/import.
router.post("/companies/import", requireCrmWrite, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const ownerId = req.user?.id ?? req.user?.userId ?? null;
  const rows: any[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!Array.isArray(req.body?.rows)) {
    return res.status(400).json({ error: { field: "rows", message: "rows[] is required" } });
  }
  if (rows.length > 20000) {
    return res.status(400).json({ error: { field: "rows", message: "too many rows (max 20000)" } });
  }

  const colRes = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'companies'`,
  );
  const cols = new Set<string>(colRes.rows.map((r: any) => r.column_name));
  const has = (c: string) => cols.has(c);
  const splitList = (v: any): string[] => String(v ?? "").split(/[;,|]/).map((s) => s.trim()).filter(Boolean);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const raw of rows) {
      const r = raw ?? {};
      const name = String(r.name ?? "").trim();
      if (!name) { skipped++; continue; }

      const industry = String(r.industry ?? "").trim() || null;
      const domain = String(r.domain ?? "").trim() || null;
      const city = String(r.city ?? "").trim() || null;
      const region = String(r.region ?? "").trim() || null;
      const financing = splitList(r.types_of_financing);
      const tags = splitList(r.tags);
      const ex = await client.query(
        `SELECT id FROM companies WHERE silo = $1 AND lower(name) = lower($2) LIMIT 1`,
        [silo, name],
      );
      const existingId: string | null = ex.rows[0]?.id ?? null;

      if (existingId) {
        const sets: string[] = [];
        const vals: any[] = [];
        let i = 1;
        const overwrite = (col: string, val: any) => {
          if (has(col) && val != null && val !== "") { sets.push(`${col} = $${i}`); vals.push(val); i++; }
        };
        overwrite("industry", industry);
        overwrite("domain", domain);
        overwrite("city", city);
        overwrite("region", region);
        if (has("types_of_financing") && financing.length) {
          sets.push(`types_of_financing = $${i}`);
          vals.push(financing);
          i++;
        }
        if (has("tags") && tags.length) {
          sets.push(`tags = (SELECT ARRAY(SELECT DISTINCT unnest(coalesce(companies.tags,'{}'::text[]) || $${i}::text[])))`);
          vals.push(tags);
          i++;
        }
        if (has("owner_id") && ownerId) { sets.push(`owner_id = COALESCE(owner_id, $${i})`); vals.push(ownerId); i++; }
        if (has("updated_at")) { sets.push("updated_at = now()"); }
        if (!sets.length) { skipped++; continue; }
        vals.push(existingId);
        await client.query(`UPDATE companies SET ${sets.join(", ")} WHERE id = $${i}`, vals);
        updated++;
      } else {
        const insCols: string[] = [];
        const ph: string[] = [];
        const vals: any[] = [];
        let i = 1;
        const add = (col: string, val: any) => {
          if (has(col)) { insCols.push(col); ph.push(`$${i}`); vals.push(val); i++; }
        };
        add("name", name);
        add("industry", industry);
        add("domain", domain);
        add("city", city);
        add("region", region);
        if (has("types_of_financing")) { insCols.push("types_of_financing"); ph.push(`$${i}`); vals.push(financing); i++; }
        if (has("tags")) { insCols.push("tags"); ph.push(`$${i}`); vals.push(tags); i++; }
        add("silo", silo);
        add("owner_id", ownerId);
        await client.query(`INSERT INTO companies (${insCols.join(", ")}) VALUES (${ph.join(", ")})`, vals);
        created++;
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return res.json({ created, updated, skipped });
}));


// BF_SERVER_BLOCK_v777_DEDUPE_PREVIEW — read-only. Counts duplicate contact
// groups (same normalized email, or same last-10 phone) and anonymous
// "Website Visitor" rows for the selected silo. NON-DESTRUCTIVE — the merge
// ships separately after review. Registered before /contacts/:id so the path
// isn't captured as an :id.
router.get("/contacts/dedupe-preview", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const emailGroups = await pool.query(
    `SELECT lower(trim(email)) AS key, count(*)::int AS n,
            array_agg(id ORDER BY created_at ASC) AS ids,
            array_agg(coalesce(name,'(no name)') ORDER BY created_at ASC) AS names
       FROM contacts
      WHERE silo = $1 AND email IS NOT NULL AND trim(email) <> ''
        AND coalesce(status,'active') <> 'archived'
      GROUP BY lower(trim(email)) HAVING count(*) > 1
      ORDER BY count(*) DESC`, [silo]);
  const phoneGroups = await pool.query(
    `SELECT right(regexp_replace(phone,'[^0-9]','','g'),10) AS key, count(*)::int AS n,
            array_agg(id ORDER BY created_at ASC) AS ids,
            array_agg(coalesce(name,'(no name)') ORDER BY created_at ASC) AS names
       FROM contacts
      WHERE silo = $1 AND phone IS NOT NULL
        AND length(regexp_replace(phone,'[^0-9]','','g')) >= 10
        AND coalesce(status,'active') <> 'archived'
      GROUP BY right(regexp_replace(phone,'[^0-9]','','g'),10) HAVING count(*) > 1
      ORDER BY count(*) DESC`, [silo]);
  const wv = await pool.query(
    `SELECT count(*)::int AS n FROM contacts
      WHERE silo = $1 AND coalesce(status,'active') <> 'archived'
        AND name ILIKE 'website visitor%'`, [silo]);
  const mergedAway = (rows: any[]) => rows.reduce((a, g) => a + (Number(g.n) - 1), 0);
  res.json({
    silo,
    emailDuplicateGroups: emailGroups.rows.length,
    emailContactsMergedAway: mergedAway(emailGroups.rows),
    phoneDuplicateGroups: phoneGroups.rows.length,
    phoneContactsMergedAway: mergedAway(phoneGroups.rows),
    websiteVisitorCount: wv.rows[0]?.n ?? 0,
    sampleEmailGroups: emailGroups.rows.slice(0, 10),
    samplePhoneGroups: phoneGroups.rows.slice(0, 10),
  });
}));

// BF_SERVER_BLOCK_v779_DEDUPE_MERGE — staff-triggered contact dedupe. Defaults to
// DRY-RUN (no changes); pass ?execute=true to apply. Merges active contacts that
// share a normalized email, then (on the survivors) a last-10 phone, into the
// earliest "canonical" row; repoints EVERY public table that has a contact_id
// column (uuid or text-like) to the canonical id; then ARCHIVES the duplicates
// (status='archived' — reversible, never hard-deleted, like v688). Also archives
// anonymous "Website Visitor" rows that have no application/message/note/task/
// call attached. Idempotent: after a run each group has one active contact.
router.post("/contacts/dedupe-merge", requireCrmWrite, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const execute = String(req.query.execute ?? "") === "true";
  const quoteIdent = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

  const refCols = await pool.query<{ table_name: string; data_type: string }>(
    `SELECT table_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'contact_id'
        AND table_name <> 'contacts'
        AND data_type IN ('uuid', 'text', 'character varying', 'character')
      ORDER BY table_name`,
  );
  const refTables = refCols.rows;

  const emailQ = `SELECT lower(trim(email)) AS key,
                         array_agg(id ORDER BY created_at ASC, id ASC) AS ids,
                         array_agg(coalesce(name,'(no name)') ORDER BY created_at ASC, id ASC) AS names
                    FROM contacts
                   WHERE silo = $1 AND email IS NOT NULL AND trim(email) <> ''
                     AND coalesce(status,'active') <> 'archived'
                   GROUP BY lower(trim(email)) HAVING count(*) > 1
                   ORDER BY count(*) DESC`;
  const phoneQ = `SELECT right(regexp_replace(phone,'[^0-9]','','g'),10) AS key,
                         array_agg(id ORDER BY created_at ASC, id ASC) AS ids,
                         array_agg(coalesce(name,'(no name)') ORDER BY created_at ASC, id ASC) AS names
                    FROM contacts
                   WHERE silo = $1 AND phone IS NOT NULL
                     AND length(regexp_replace(phone,'[^0-9]','','g')) >= 10
                     AND coalesce(status,'active') <> 'archived'
                   GROUP BY right(regexp_replace(phone,'[^0-9]','','g'),10) HAVING count(*) > 1
                   ORDER BY count(*) DESC`;
  const wvWhere = `c.silo = $1 AND c.name ILIKE 'website visitor%'
          AND coalesce(c.status,'active') <> 'archived'
          AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.contact_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM application_contacts ac WHERE ac.contact_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM communications_messages m WHERE m.contact_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM crm_notes n WHERE n.contact_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM crm_tasks t WHERE t.contact_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM call_events e WHERE e.contact_id = c.id)`;
  const toPlan = (rows: any[]) => rows.map((r: any) => ({
    key: r.key,
    canonicalId: r.ids[0],
    dupIds: r.ids.slice(1),
    names: r.names,
  }));
  const planArchiveCount = (plan: any[]) => plan.reduce((a: number, g: any) => a + g.dupIds.length, 0);

  if (!execute) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const eg = await client.query(emailQ, [silo]);
      const emailPlan = toPlan(eg.rows);
      for (const g of emailPlan) {
        if (g.dupIds.length) {
          await client.query(`UPDATE contacts SET status='archived' WHERE id = ANY($1::uuid[])`, [g.dupIds]);
        }
      }
      const pg = await client.query(phoneQ, [silo]);
      await client.query("ROLLBACK");

      const phonePlan = toPlan(pg.rows);
      const wv = await pool.query(`SELECT count(*)::int AS n FROM contacts c WHERE ${wvWhere}`, [silo]);
      res.json({
        mode: "dry-run", silo,
        emailGroups: emailPlan.length,
        emailContactsToArchive: planArchiveCount(emailPlan),
        phoneGroups: phonePlan.length,
        phoneContactsToArchive: planArchiveCount(phonePlan),
        anonymousWebsiteVisitorsToArchive: wv.rows[0]?.n ?? 0,
        referenceTablesRepointed: refTables.map((t: { table_name: string }) => t.table_name),
        sampleEmailGroups: emailPlan.slice(0, 10),
        samplePhoneGroups: phonePlan.slice(0, 10),
        note: "DRY-RUN — nothing changed. Re-run with ?execute=true to apply.",
      });
      return;
    } catch (e: any) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        // Ignore rollback failures; surface the original error.
      }
      throw e;
    } finally {
      client.release();
    }
  }

  const client = await pool.connect();
  const repointed: Record<string, number> = {};
  let archived = 0;
  try {
    await client.query("BEGIN");
    const mergeGroups = async (groups: any[]) => {
      for (const g of groups) {
        if (!g.dupIds?.length) continue;
        for (const t of refTables) {
          const tableName = quoteIdent(t.table_name);
          const sql = t.data_type === "uuid"
            ? `UPDATE public.${tableName} SET contact_id = $1 WHERE contact_id = ANY($2::uuid[])`
            : `UPDATE public.${tableName} SET contact_id = $1::text WHERE contact_id::text = ANY($2::text[])`;
          const r = await client.query(sql, [g.canonicalId, g.dupIds]);
          if (r.rowCount) repointed[t.table_name] = (repointed[t.table_name] ?? 0) + r.rowCount;
        }
        const a = await client.query(
          `UPDATE contacts SET status='archived', updated_at=now() WHERE id = ANY($1::uuid[])`,
          [g.dupIds],
        );
        archived += a.rowCount ?? 0;
      }
    };
    const eg = await client.query(emailQ, [silo]);
    await mergeGroups(toPlan(eg.rows));
    const pg = await client.query(phoneQ, [silo]); // survivors only
    await mergeGroups(toPlan(pg.rows));
    const wv = await client.query(`UPDATE contacts c SET status='archived', updated_at=now() WHERE ${wvWhere}`, [silo]);
    await client.query("COMMIT");
    res.json({
      mode: "executed",
      silo,
      contactsArchived: archived,
      anonymousWebsiteVisitorsArchived: wv.rowCount ?? 0,
      referencesRepointed: repointed,
    });
  } catch (e: any) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}));

router.get("/contacts/:id", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "invalid_id" });
  }
  const silo = resolveSiloFromRequest(req);
  const { rows } = await pool.query(
    `SELECT c.*,
            co.name AS company_name,
            (u.first_name || ' ' || u.last_name) AS owner_name
     FROM contacts c
     LEFT JOIN companies co ON co.id = c.company_id
     LEFT JOIN users u ON u.id = c.owner_id
     WHERE c.id = $1 AND c.silo = $2
     LIMIT 1`,
    [id, silo],
  );
  if (!rows.length) return res.status(404).json({ error: "not_found" });
  res.json({ data: rows[0] });
}));

router.patch("/contacts/:id", requireCrmWrite, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  const ALLOWED = [
    "first_name", "last_name", "name", "email", "phone", "job_title",
    "lead_status", "lifecycle_stage", "owner_id", "company_id", "notes",
  ];
  const updates: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const k of ALLOWED) {
    if (k in (req.body ?? {})) {
      updates.push(`${k} = $${i++}`);
      params.push(req.body[k] === "" ? null : req.body[k]);
    }
  }
  if (!updates.length) return res.json({ data: null });
  params.push(id);
  const { rows } = await pool.query(
    `UPDATE contacts SET ${updates.join(", ")}, updated_at = NOW()
     WHERE id = $${i} RETURNING *`,
    params,
  );
  res.json({ data: rows[0] ?? null });
}));

router.get("/companies", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const q = String(req.query.q ?? "").trim();
  const sort = String(req.query.sort ?? "created_at:desc");
  const [sortColRaw, sortDirRaw] = sort.split(":");
  const sortColAllowed = ["name", "industry", "owner_name", "created_at"];
  const sortCol = sortColAllowed.includes(sortColRaw) ? sortColRaw : "created_at";
  const sortDir = sortDirRaw === "asc" ? "ASC" : "DESC";

  const params: unknown[] = [silo];
  let where = "co.silo = $1";
  if (q) {
    params.push(`%${q}%`);
    where +=
      ` AND (co.name ILIKE $${params.length}` +
      ` OR co.domain ILIKE $${params.length}` +
      ` OR co.industry ILIKE $${params.length}` +
      ` OR array_to_string(coalesce(co.tags, '{}'::text[]), ' ') ILIKE $${params.length}` +
      ` OR array_to_string(coalesce(co.types_of_financing, '{}'::text[]), ' ') ILIKE $${params.length}` +
      ` OR coalesce(co.city, '') ILIKE $${params.length}` +
      ` OR coalesce(co.region, '') ILIKE $${params.length}` +
      ` OR coalesce(u.first_name || ' ' || u.last_name, '') ILIKE $${params.length})`;
  }
  // BF_SERVER_CRM_COMPANY_OWNER_FILTER — owner dropdown parity with contacts.
  const ownerId = String(req.query.owner_id ?? "").trim();
  if (ownerId) {
    params.push(ownerId);
    where += ` AND co.owner_id = $${params.length}`;
  }
  // BF_SERVER_CRM_COMPANY_TAG_FILTER — single-tag filter parity with contacts.
  const tagFilter = String(req.query.tag ?? "").trim().toLowerCase();
  if (tagFilter) {
    params.push(tagFilter);
    where += ` AND EXISTS (SELECT 1 FROM unnest(coalesce(co.tags, '{}'::text[])) t WHERE lower(t) = $${params.length})`;
  }
  const { rows } = await pool.query(
    `SELECT co.*, (u.first_name || ' ' || u.last_name) AS owner_name
     FROM companies co
     LEFT JOIN users u ON u.id = co.owner_id
     WHERE ${where}
     ORDER BY ${sortCol === "owner_name" ? "owner_name" : "co." + sortCol} ${sortDir}
     LIMIT 500`,
    params,
  );
  res.json({ data: rows });
}));

router.get("/companies/:id", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "invalid_id" });
  }
  const silo = resolveSiloFromRequest(req);
  const { rows } = await pool.query(
    `SELECT co.*, (u.first_name || ' ' || u.last_name) AS owner_name
     FROM companies co
     LEFT JOIN users u ON u.id = co.owner_id
     WHERE co.id = $1 AND co.silo = $2
     LIMIT 1`,
    [id, silo],
  );
  if (!rows.length) return res.status(404).json({ error: "not_found" });
  res.json({ data: rows[0] });
}));

router.post("/companies", requireCrmWrite, safeHandler(async (req: any, res: any) => {
  const silo = String(getSilo(res) ?? req.user?.silo ?? "BF").toUpperCase();
  const b = req.body ?? {};
  const name = String(b.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  const { rows } = await pool.query(
    `INSERT INTO companies
       (name, industry, domain, city, region, types_of_financing,
        owner_id, silo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      name,
      b.industry ?? null,
      b.domain ?? null,
      b.city ?? null,
      b.region ?? null,
      Array.isArray(b.types_of_financing) ? b.types_of_financing : [],
      req.user?.id ?? req.user?.userId ?? null,
      silo,
    ],
  );
  res.status(201).json({ data: rows[0] });
}));

router.patch("/companies/:id", requireCrmWrite, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  const ALLOWED = ["name", "industry", "domain", "city", "region", "types_of_financing", "owner_id"];
  const updates: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const k of ALLOWED) {
    if (k in (req.body ?? {})) {
      updates.push(`${k} = $${i++}`);
      params.push(req.body[k]);
    }
  }
  if (!updates.length) return res.json({ data: null });
  params.push(id);
  const { rows } = await pool.query(
    `UPDATE companies SET ${updates.join(", ")}, updated_at = NOW()
     WHERE id = $${i} RETURNING *`,
    params,
  );
  res.json({ data: rows[0] ?? null });
}));

router.delete("/contacts/:id", requireAdmin, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: "invalid_id" });
  const silo = String(getSilo(res) ?? req.user?.silo ?? "BF").toUpperCase();
  const { rowCount } = await pool.query(
    `DELETE FROM contacts WHERE id = $1 AND silo = $2`, [id, silo],
  );
  if (!rowCount) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
}));

router.delete("/companies/:id", requireAdmin, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: "invalid_id" });
  const silo = String(getSilo(res) ?? req.user?.silo ?? "BF").toUpperCase();
  const { rowCount } = await pool.query(
    `DELETE FROM companies WHERE id = $1 AND silo = $2`, [id, silo],
  );
  if (!rowCount) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
}));

// BF_SERVER_BLOCK_v326_TIMELINE_CALLS_v1
// Portal dialer POSTs every completed call to
// /api/crm/timeline/calls with the shape
// { contactId, number, durationSeconds, outcome, failureReason }.
// Pre-fix that endpoint returned 404 because the only POST route
// for calls is mounted under /contacts/:id/calls (handled by
// callsActivityRoutes from ./crm/calls.js). The dialer code does
// not know the contact id at the path-segment level -- it knows
// the contactId only in the body. So the POST flow needs a
// body-keyed endpoint, not a path-keyed one.
//
// This route persists to the SAME crm_call_log table that the
// /contacts/:id/calls handler writes to, so the timeline UNION in
// ./crm/timeline.ts continues to surface these rows. Direction
// defaults to 'outbound' (the only thing the portal dialer fires
// today; inbound logging will route through the Twilio webhook
// handler, not this endpoint). Notes column packs outcome +
// failureReason as a tagged string for now -- a later block adds
// dedicated outcome/failure columns once the dialer's call state
// machine is consolidated (v200 dialer consolidation).
router.post("/timeline/calls", requireCrmWrite, safeHandler(async (req: any, res: any) => {
  // BF_SERVER_BLOCK_47_v1 -- FK-safe insert. The portal dialer
  // sometimes hands us a contact_id / company_id / user_id that
  // doesn't exist in the DB (web dialer fires before the contact
  // is fully created; or a phone-only call has no contact). The
  // INSERT then fails with a 23503 FK violation -> safeHandler
  // returns 409 "constraint_violation". Validate first; null any
  // ref that doesn't resolve so the call still records.
  const rawUserId = req.user?.id ?? req.user?.userId ?? null;
  const silo = resolveSiloFromRequest(req);
  const b = req.body ?? {};
  const rawContactId: string | null = b.contactId ?? b.contact_id ?? null;
  const rawCompanyId: string | null = b.companyId ?? b.company_id ?? null;
  const toNumber: string | null = b.number ?? b.to ?? b.to_number ?? null;
  const durationSec: number | null =
    typeof b.durationSeconds === "number" ? b.durationSeconds
      : typeof b.duration_sec === "number" ? b.duration_sec
        : null;
  if (!rawContactId && !toNumber) {
    return res.status(400).json({ error: { message: "contactId or number required", code: "validation_error" } });
  }

  // Helper -- resolve a UUID against a table; return the id if it
  // exists, else null. Cheap (PK lookup) and safe.
  async function resolve(id: string | null, table: "contacts" | "companies" | "users"): Promise<string | null> {
    if (!id || typeof id !== "string") return null;
    // basic UUID shape gate so we never blow up the query
    if (!/^[0-9a-f-]{32,40}$/i.test(id)) return null;
    try {
      const r = await pool.query(`SELECT id FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
      return r.rowCount && r.rowCount > 0 ? id : null;
    } catch {
      return null;
    }
  }

  const [contactId, companyId, userId] = await Promise.all([
    resolve(rawContactId, "contacts"),
    resolve(rawCompanyId, "companies"),
    resolve(rawUserId, "users"),
  ]);

  // BF_SERVER_BLOCK_v335_CALL_CONTACT_BY_PHONE_v1 — dialer calls often arrive with no
  // contactId, so they never attach to a contact on the timeline. When contactId is
  // null, resolve the OTHER party's phone (to_number for outbound, from_number for
  // inbound) to a contact in this silo by last-10 digits and stamp it.
  let resolvedContactId: string | null = contactId;
  if (!resolvedContactId) {
    const dir = String(b.direction ?? "outbound");
    const fromNumber = b.fromNumber ?? b.from_number ?? null;
    const otherParty = dir === "inbound" ? fromNumber : toNumber;
    const d = String(otherParty ?? "").replace(/[^0-9]/g, "").slice(-10);
    if (d) {
      try {
        const m = await pool.query(
          `SELECT id FROM contacts
             WHERE silo = $1
               AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $2
             ORDER BY created_at ASC LIMIT 1`,
          [silo, d],
        );
        if (m.rows[0]?.id) resolvedContactId = m.rows[0].id as string;
      } catch { /* best-effort; never block call logging */ }
    }
  }

  const outcomePart = b.outcome ? `outcome:${b.outcome}` : null;
  const failurePart = b.failureReason ? `failure:${b.failureReason}` : null;
  const notes = [outcomePart, failurePart].filter(Boolean).join(" ") || null;
  const { rows } = await pool.query(
    `INSERT INTO crm_call_log
       (direction, from_number, to_number, twilio_call_sid, duration_sec,
        recording_url, notes, owner_id, contact_id, company_id, silo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      String(b.direction ?? "outbound"),
      b.fromNumber ?? b.from_number ?? null,
      toNumber,
      b.callSid ?? b.twilio_call_sid ?? null,
      durationSec,
      b.recordingUrl ?? b.recording_url ?? null,

      notes,
      userId,
      resolvedContactId,
      companyId,
      silo,
    ],
  );
  void bumpBiOutreachToContacted(resolvedContactId); // BF_SERVER_BLOCK_v344_BI_OUTREACH_AUTOADVANCE_v1
  res.status(201).json({
    ok: true,
    data: rows[0],
    // Echo back any IDs that didn't resolve so the dialer can
    // re-link a created contact later (or just log it).
    nulled: {
      contact_id: rawContactId && !contactId ? rawContactId : null,
      company_id: rawCompanyId && !companyId ? rawCompanyId : null,
      owner_id: rawUserId && !userId ? rawUserId : null,
    },
  });
}));

// #48 — contact email feed: subject/body for inline expand + read-receipt.
router.get("/contacts/:id/emails", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "invalid_id" });
  }
  const { rows } = await pool.query(
    `SELECT id, subject, body_html, from_address, to_addresses, opened_at, created_at
       FROM crm_email_log
      WHERE contact_id = $1
      ORDER BY created_at DESC
      LIMIT 200`,
    [id]
  );
  return res.json({ items: rows });
}));

// #49 — contact call feed: recording + transcript joined by conference.
router.get("/contacts/:id/calls", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "invalid_id" });
  }
  const { rows } = await pool.query(
    `SELECT cf.id AS conference_id,
            cf.direction,
            cf.started_at,
            cf.ended_at,
            cf.created_at,
            r.url           AS recording_url,
            r.duration_sec  AS recording_duration_sec,
            r.status        AS recording_status,
            t.full_text     AS transcript_text,
            t.segments_json AS transcript_segments,
            t.voice_intelligence_summary AS transcript_summary
       FROM conferences cf
       LEFT JOIN call_recordings  r ON r.conference_id = cf.id
       LEFT JOIN call_transcripts t ON t.conference_id = cf.id
      WHERE cf.contact_id = $1
      ORDER BY cf.created_at DESC
      LIMIT 200`,
    [id]
  );
  return res.json({ items: rows });
}));

router.use("/contacts/:id/notes", notesRoutes);
router.use("/contacts/:id/tasks", tasksRoutes);
router.use("/contacts/:id/emails", emailsRoutes);
router.use("/contacts/:id/meetings", meetingsRoutes);
router.use("/contacts/:id/calls", callsActivityRoutes);
router.use("/contacts/:id/timeline", timelineRoutes);

router.use("/companies/:id/notes", notesRoutes);
router.use("/companies/:id/tasks", tasksRoutes);
router.use("/companies/:id/emails", emailsRoutes);
router.use("/companies/:id/meetings", meetingsRoutes);
router.use("/companies/:id/calls", callsActivityRoutes);
router.use("/companies/:id/timeline", timelineRoutes);

router.use("/shared-mailboxes", sharedMailboxesRoutes);
router.use("/inbox", inboxRoutes);
router.use("/voicemails", voicemailsRoutes); // BF_SERVER_BLOCK_v830_VOICEMAILS_LIST

router.get("/timeline", safeHandler(handleListCrmTimeline));
router.get("/web-leads", SupportController.fetchWebLeads);

const ids = (v: any) => Array.isArray(v) ? v.map(String).filter(Boolean) : [];

router.post('/contacts/bulk-delete', safeHandler(async (req: any, res: any) => {
  const selected = ids(req.body?.ids); const silo = getSilo(res);
  if (!selected.length) return res.json({ deleted: 0, protectedIds: [] });
  // v692: protect contacts attached to an application (direct FK or join table).
  // (Previous code joined a non-existent lenders.owner_contact_id column -> crash.)
  const protectedRes = await pool.query(
    `SELECT c.id FROM contacts c
      WHERE c.id = ANY($1::uuid[]) AND c.silo = $2
        AND (EXISTS (SELECT 1 FROM applications a WHERE a.contact_id = c.id)
             OR EXISTS (SELECT 1 FROM application_contacts ac WHERE ac.contact_id = c.id))`,
    [selected, silo]
  );
  const protectedIds = protectedRes.rows.map((r:any)=>r.id);
  if (protectedIds.length) return res.status(409).json({ error: 'fk_protected', protectedIds });
  const out = await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[]) AND silo = $2`, [selected, silo]);
  res.json({ deleted: out.rowCount ?? 0, protectedIds: [] });
}));

router.post('/contacts/bulk-tag', safeHandler(async (req: any, res: any) => {
  const selected = ids(req.body?.ids); const tags = ids(req.body?.tags); const op = String(req.body?.op ?? 'add'); const silo = getSilo(res);
  let sql = `UPDATE contacts SET tags = $2::text[] WHERE id = ANY($1::uuid[]) AND silo = $3`;
  const params:any[] = [selected, tags, silo];
  if (op === 'add') { sql = `UPDATE contacts SET tags = (SELECT ARRAY(SELECT DISTINCT unnest(coalesce(contacts.tags,'{}'::text[]) || $2::text[]))) WHERE id = ANY($1::uuid[]) AND silo = $3`; }
  if (op === 'remove') { sql = `UPDATE contacts SET tags = ARRAY(SELECT t FROM unnest(coalesce(tags,'{}'::text[])) t WHERE NOT (t = ANY($2::text[]))) WHERE id = ANY($1::uuid[]) AND silo = $3`; }
  const out = await pool.query(sql, params); res.json({ updated: out.rowCount ?? 0 });
}));

router.post('/contacts/bulk-assign', safeHandler(async (req: any, res: any) => {
  const selected = ids(req.body?.ids); const ownerUserId = String(req.body?.ownerUserId ?? ''); const silo = getSilo(res);
  const u = await pool.query(`SELECT id FROM users WHERE id::text = ($1)::text LIMIT 1`, [ownerUserId]); if (!u.rows[0]) return res.status(400).json({ error: 'invalid_owner' });
  const out = await pool.query(`UPDATE contacts SET owner_id = $2 WHERE id = ANY($1::uuid[]) AND silo = $3`, [selected, ownerUserId, silo]); res.json({ updated: out.rowCount ?? 0 });
}));

router.post('/companies/bulk-delete', safeHandler(async (req: any, res: any) => {
  const selected = ids(req.body?.ids); const silo = getSilo(res);
  const prot = await pool.query(`SELECT id FROM companies WHERE id = ANY($1::uuid[]) AND silo = $2 AND (EXISTS (SELECT 1 FROM contacts c WHERE c.company_id = companies.id) OR EXISTS (SELECT 1 FROM applications a WHERE a.company_id = companies.id))`, [selected, silo]);
  const protectedIds = prot.rows.map((r:any)=>r.id); if (protectedIds.length) return res.status(409).json({ error:'fk_protected', protectedIds });
  const out = await pool.query(`DELETE FROM companies WHERE id = ANY($1::uuid[]) AND silo = $2`, [selected, silo]); res.json({ deleted: out.rowCount ?? 0, protectedIds: [] });
}));

router.post('/companies/bulk-tag', safeHandler(async (req: any, res: any) => {
  const selected = ids(req.body?.ids); const tags = ids(req.body?.tags); const op = String(req.body?.op ?? 'add'); const silo = getSilo(res);
  let sql = `UPDATE companies SET tags = $2::text[] WHERE id = ANY($1::uuid[]) AND silo = $3`;
  if (op === 'add') sql = `UPDATE companies SET tags = (SELECT ARRAY(SELECT DISTINCT unnest(coalesce(companies.tags,'{}'::text[]) || $2::text[]))) WHERE id = ANY($1::uuid[]) AND silo = $3`;
  if (op === 'remove') sql = `UPDATE companies SET tags = ARRAY(SELECT t FROM unnest(coalesce(tags,'{}'::text[])) t WHERE NOT (t = ANY($2::text[]))) WHERE id = ANY($1::uuid[]) AND silo = $3`;
  const out = await pool.query(sql, [selected, tags, silo]); res.json({ updated: out.rowCount ?? 0 });
}));

router.post('/companies/bulk-assign', safeHandler(async (req: any, res: any) => {
  const selected = ids(req.body?.ids); const ownerUserId = String(req.body?.ownerUserId ?? ''); const silo = getSilo(res);
  const u = await pool.query(`SELECT id FROM users WHERE id::text = ($1)::text LIMIT 1`, [ownerUserId]); if (!u.rows[0]) return res.status(400).json({ error: 'invalid_owner' });
  const out = await pool.query(`UPDATE companies SET owner_id = $2 WHERE id = ANY($1::uuid[]) AND silo = $3`, [selected, ownerUserId, silo]); res.json({ updated: out.rowCount ?? 0 });
}));


export default router;
