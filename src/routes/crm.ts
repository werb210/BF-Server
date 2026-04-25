import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";
import { handleListCrmTimeline } from "../modules/crm/timeline.controller.js";
import { SupportController } from "../modules/support/support.controller.js";
import { pool } from "../db.js";
import notesRoutes from "./crm/notes.js";
import tasksRoutes from "./crm/tasks.js";
import emailsRoutes from "./crm/emails.js";
import meetingsRoutes from "./crm/meetings.js";
import callsActivityRoutes from "./crm/calls.js";
import timelineRoutes from "./crm/timeline.js";
import sharedMailboxesRoutes from "./crm/sharedMailboxes.js";
import inboxRoutes from "./crm/inbox.js";

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
  const { getSilo } = await import("../middleware/silo.js");
  const rawSilo = getSilo(res);
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
    first_name,
    last_name,
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

  const fname = (first_name ?? "").toString().trim();
  const lname = (last_name ?? "").toString().trim();
  const fullName = (name ?? "").toString().trim() || [fname, lname].filter(Boolean).join(" ").trim();

  if (!fullName && !fname) {
    return res.status(400).json({ error: "first_name or name is required" });
  }

  const VALID_SILOS = ["BF", "BI", "SLF"];
  const contactSilo = VALID_SILOS.includes((req.body?.silo ?? "").toUpperCase())
    ? req.body.silo.toUpperCase()
    : "BF";

  const { rows } = await pool.query(
    `INSERT INTO contacts
      (name, first_name, last_name, email, phone, status, silo, user_id,
       company_name, job_title, lead_status, tags, owner_id, company_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id, name, first_name, last_name, email, phone, status,
               company_name, job_title, lead_status, tags, owner_id,
               company_id, created_at, silo`,
    [
      fullName,
      fname || null,
      lname || null,
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


router.get("/contacts/:id", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "invalid_id" });
  }
  const silo = String(req.query.silo ?? req.user?.silo ?? "BF").toUpperCase();
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

router.patch("/contacts/:id", safeHandler(async (req: any, res: any) => {
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
  const silo = String(req.query.silo ?? req.user?.silo ?? "BF").toUpperCase();
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
    where += ` AND (co.name ILIKE $${params.length} OR co.domain ILIKE $${params.length} OR co.industry ILIKE $${params.length})`;
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
  const silo = String(req.query.silo ?? req.user?.silo ?? "BF").toUpperCase();
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

router.post("/companies", safeHandler(async (req: any, res: any) => {
  const silo = String(req.user?.silo ?? "BF").toUpperCase();
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

router.patch("/companies/:id", safeHandler(async (req: any, res: any) => {
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

router.get("/timeline", safeHandler(handleListCrmTimeline));
router.get("/web-leads", SupportController.fetchWebLeads);

export default router;
