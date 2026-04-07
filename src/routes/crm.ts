import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth";
import { CAPABILITIES } from "../auth/capabilities";
import { safeHandler } from "../middleware/safeHandler";
import { ok } from "../lib/response";
import { handleListCrmTimeline } from "../modules/crm/timeline.controller";
import { SupportController } from "../modules/support/support.controller";

const router = Router();

// Public website lead intake endpoint
router.post("/web-leads", SupportController.createWebLead);

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.CRM_READ]));

router.get("/", safeHandler((req: any) => {
  return ok({
    customers: [],
    contacts: [],
    totalCustomers: 0,
    totalContacts: 0,
  }, req.rid);
}));

router.get("/customers", safeHandler((req: any) => {
  const page = Number(req.query.page) || 1;
  const pageSize = Number(req.query.pageSize) || 25;
  return ok({ customers: [], total: 0, page, pageSize }, req.rid);
}));

router.get("/contacts", safeHandler((req: any) => {
  const page = Number(req.query.page) || 1;
  const pageSize = Number(req.query.pageSize) || 25;
  return ok({ contacts: [], total: 0, page, pageSize }, req.rid);
}));

router.get("/timeline", safeHandler(handleListCrmTimeline));
router.get("/web-leads", SupportController.fetchWebLeads);

export default router;
