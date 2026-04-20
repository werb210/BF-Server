import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";
import { handleListCrmTimeline } from "../modules/crm/timeline.controller.js";
import { SupportController } from "../modules/support/support.controller.js";
import { pool } from "../db.js";

const router = Router();

// Public website lead intake endpoint
router.post("/web-leads", SupportController.createWebLead);

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.CRM_READ]));

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
  try {
    const { rows } = await pool.query(
      `SELECT id, stage
       FROM applications
       WHERE contact_id = $1
         AND COALESCE(archived, false) = false`,
      [req.params.id]
    );

    return res.json(rows);
  } catch {
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
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const ownerId = typeof req.query.owner_id === "string" ? req.query.owner_id.trim() : "";
  const leadStatus = typeof req.query.lead_status === "string" ? req.query.lead_status.trim() : "";
  const hasActiveApplications = req.query.has_active_applications === "true";

  const VALID_SILOS = ["BF", "BI", "SLF"];
  const rawSilo = typeof req.query.silo === "string" ? req.query.silo.toUpperCase() : "BF";
  const silo = VALID_SILOS.includes(rawSilo) ? rawSilo : "BF";

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
    LEFT JOIN users u ON ${hasOwnerId ? "c.owner_id = u.id" : "false"}
    WHERE ${where.join(" AND ")}
    ORDER BY c.created_at DESC
    LIMIT $${values.length - 1} OFFSET $${values.length}`;

  const { rows } = await pool.query(sql, values);
  respondOk(res, rows, { page, pageSize });
}));

router.post("/contacts", safeHandler(async (req: any, res: any) => {
  const {
    name,
    email,
    phone,
    status,
    company_name,
    job_title,
    lead_status,
    tags,
    owner_id,
    company_id,
  } = req.body ?? {};

  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  const VALID_SILOS = ["BF", "BI", "SLF"];
  const contactSilo = VALID_SILOS.includes((req.body?.silo ?? "").toUpperCase())
    ? req.body.silo.toUpperCase()
    : "BF";

  const { rows } = await pool.query(
    `INSERT INTO contacts
      (name, email, phone, status, silo, user_id, company_name, job_title, lead_status, tags, owner_id, company_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, name, email, phone, status, company_name, job_title, lead_status, tags, owner_id, company_id, created_at, silo`,
    [
      name,
      email ?? null,
      phone ?? null,
      status ?? "active",
      contactSilo,
      req.user?.userId ?? req.user?.id ?? null,
      company_name ?? null,
      job_title ?? null,
      lead_status ?? "New",
      Array.isArray(tags) ? tags : [],
      owner_id ?? null,
      company_id ?? null,
    ]
  );

  return res.status(201).json({ ok: true, data: rows[0] });
}));

router.get("/timeline", safeHandler(handleListCrmTimeline));
router.get("/web-leads", SupportController.fetchWebLeads);

export default router;
