import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";
import { handleListCrmTimeline } from "../modules/crm/timeline.controller.js";
import { SupportController } from "../modules/support/support.controller.js";
import { createLead } from "../modules/lead/lead.service.js";
const router = Router();
// Public website lead intake endpoint
router.post("/web-leads", SupportController.createWebLead);
// Canonical lead creation endpoint — called by Website, BF-client, and Agent
// Placed before requireAuth so the website can submit without a token
router.post("/lead", safeHandler(async (req, res) => {
    const payload = {
        source: req.body?.source ?? "website",
        companyName: req.body?.company_name ?? req.body?.companyName ?? req.body?.businessName,
        fullName: req.body?.full_name ?? req.body?.fullName ?? req.body?.name,
        email: req.body?.email,
        phone: req.body?.phone,
        requestedAmount: req.body?.requested_amount ?? req.body?.requestedAmount ?? req.body?.fundingAmount,
        monthlyRevenue: req.body?.monthly_revenue ?? req.body?.monthlyRevenue,
        annualRevenue: req.body?.annual_revenue ?? req.body?.annualRevenue,
        productInterest: req.body?.product_interest ?? req.body?.productInterest ?? req.body?.product,
        industryInterest: req.body?.industry_interest ?? req.body?.industryInterest ?? req.body?.industry,
        notes: req.body?.notes ?? req.body?.message,
        tags: req.body?.tags,
    };
    const result = await createLead(payload);
    return respondOk(res, result);
}));
router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.CRM_READ]));
router.get("/", safeHandler((_req, res) => {
    respondOk(res, {
        customers: [],
        contacts: [],
        totalCustomers: 0,
        totalContacts: 0,
    });
}));
router.get("/customers", safeHandler((req, res) => {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 25;
    respondOk(res, {
        customers: [],
        total: 0,
    }, {
        page,
        pageSize,
    });
}));
router.get("/contacts", safeHandler((req, res) => {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 25;
    respondOk(res, {
        contacts: [],
        total: 0,
    }, {
        page,
        pageSize,
    });
}));
router.get("/timeline", safeHandler(handleListCrmTimeline));
router.get("/web-leads", SupportController.fetchWebLeads);
export default router;
