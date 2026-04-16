import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";
import { handleListCrmTimeline } from "../modules/crm/timeline.controller.js";
import { handleListContacts } from "../modules/crm/contacts.controller.js";
import { SupportController } from "../modules/support/support.controller.js";

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

router.get("/contacts", safeHandler(handleListContacts));

router.get("/timeline", safeHandler(handleListCrmTimeline));
router.get("/web-leads", SupportController.fetchWebLeads);

export default router;
