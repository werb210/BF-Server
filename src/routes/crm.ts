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
  const page = Number(req.query.page) || 1;
  const pageSize = Math.min(Number(req.query.pageSize) || 200, 500);
  const offset = (page - 1) * pageSize;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : null;
  // hasActiveApplications filter defaults to FALSE — don't filter by default
  const hasActiveApps = req.query.hasActiveApplications === "true" ? true : false;
  const ownerId = typeof req.query.ownerId === "string" ? req.query.ownerId.trim() : null;

  const contacts: any[] = [];
  const VALID_SILOS = ["BF", "BI", "SLF"];
  const rawSilo = typeof req.query.silo === "string" ? req.query.silo.toUpperCase() : "BF";
  const siloValue = VALID_SILOS.includes(rawSilo) ? rawSilo : "BF";

  const contactApplicationLinkColumns: string[] = [];
  try {
    const { rows: contactIdColumnRows } = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'applications'
         AND column_name IN ('contact_id', 'crm_contact_id')`
    );
    contactApplicationLinkColumns.push(...contactIdColumnRows.map((row) => row.column_name));
  } catch {
    // applications table/metadata not available — skip application filter wiring
  }

  const activeApplicationPredicate = contactApplicationLinkColumns.length > 0
    ? `EXISTS (SELECT 1
              FROM applications a
              WHERE ${contactApplicationLinkColumns.map((columnName) => `a.${columnName} = c.id`).join(" OR ")})`
    : "FALSE";

  // Try contacts table (may not exist yet — safe catch)
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.email, c.phone, c.status, c.silo, c.created_at, c.user_id, u.email AS owner_email, 'contact' AS source
       FROM contacts c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.silo = $1
       ${ownerId ? `AND c.user_id = $4` : ""}
       ${hasActiveApps ? `AND ${activeApplicationPredicate}` : ""}
       ${search ? `AND (c.name ILIKE $${ownerId ? 5 : 4} OR c.email ILIKE $${ownerId ? 5 : 4} OR c.phone ILIKE $${ownerId ? 5 : 4} OR u.email ILIKE $${ownerId ? 5 : 4})` : ""}
       ORDER BY c.created_at DESC
       LIMIT $2 OFFSET $3`,
      search
        ? (ownerId ? [siloValue, pageSize, offset, ownerId, `%${search}%`] : [siloValue, pageSize, offset, `%${search}%`])
        : (ownerId ? [siloValue, pageSize, offset, ownerId] : [siloValue, pageSize, offset])
    );
    contacts.push(...rows);
  } catch {
    // contacts table doesn't exist yet — skip
  }

  // Also pull from crm_leads (always exists)
  try {
    const searchClause = search ? "WHERE full_name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1" : "";
    const { rows } = await pool.query(
      `SELECT id, full_name AS name, email, phone, null AS status, created_at, 'lead' AS source
       FROM crm_leads
       ${searchClause}
       ORDER BY created_at DESC
       LIMIT $${search ? 2 : 1} OFFSET $${search ? 3 : 2}`,
      search ? [`%${search}%`, pageSize, offset] : [pageSize, offset]
    );
    contacts.push(...rows);
  } catch {
    // crm_leads table doesn't exist — skip
  }

  const sorted = contacts
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, pageSize);

  respondOk(res, sorted);
}));

router.post("/contacts", safeHandler(async (req: any, res: any) => {
  const { name, email, phone, status } = req.body ?? {};

  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  const VALID_SILOS = ["BF", "BI", "SLF"];
  const contactSilo = VALID_SILOS.includes((req.body?.silo ?? "").toUpperCase())
    ? req.body.silo.toUpperCase()
    : "BF";

  try {
    const { rows } = await pool.query(
      `INSERT INTO contacts (name, email, phone, status, silo, user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, email, phone, status, created_at, user_id`,
      [name, email ?? null, phone ?? null, status ?? "active", contactSilo, req.user?.id ?? null]
    );

    return res.status(201).json({ ok: true, data: { ...rows[0], silo: contactSilo } });
  } catch (error: any) {
    if (error?.code !== "42703") {
      throw error;
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO contacts (name, email, phone, status, user_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, email, phone, status, created_at, user_id`,
        [name, email ?? null, phone ?? null, status ?? "active", req.user?.id ?? null]
      );

      return res.status(201).json({ ok: true, data: { ...rows[0], silo: contactSilo } });
    } catch (fallbackError: any) {
      throw Object.assign(new Error(`Failed to create contact without silo column: ${fallbackError?.message ?? "unknown error"}`), {
        cause: fallbackError,
      });
    }
  }
}));

router.get("/timeline", safeHandler(handleListCrmTimeline));
router.get("/web-leads", SupportController.fetchWebLeads);

export default router;
