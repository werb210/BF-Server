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
  const pageSize = Math.min(Number(req.query.pageSize) || 25, 100);
  const offset = (page - 1) * pageSize;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : null;

  const contacts: any[] = [];

  // Try contacts table (may not exist yet — safe catch)
  try {
    const searchClause = search ? "WHERE c.name ILIKE $1 OR c.email ILIKE $1 OR c.phone ILIKE $1" : "";
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.email, c.phone, c.status, c.created_at, 'contact' AS source
       FROM contacts c
       ${searchClause}
       ORDER BY c.created_at DESC
       LIMIT $${search ? 2 : 1} OFFSET $${search ? 3 : 2}`,
      search ? [`%${search}%`, pageSize, offset] : [pageSize, offset]
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

router.get("/timeline", safeHandler(handleListCrmTimeline));
router.get("/web-leads", SupportController.fetchWebLeads);

export default router;
