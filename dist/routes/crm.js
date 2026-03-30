"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const capabilities_1 = require("../auth/capabilities");
const safeHandler_1 = require("../middleware/safeHandler");
const respondOk_1 = require("../utils/respondOk");
const timeline_controller_1 = require("../modules/crm/timeline.controller");
const support_controller_1 = require("../modules/support/support.controller");
const router = (0, express_1.Router)();
// Public website lead intake endpoint
router.post("/web-leads", support_controller_1.SupportController.createWebLead);
router.use(auth_1.requireAuth);
router.use((0, auth_1.requireCapability)([capabilities_1.CAPABILITIES.CRM_READ]));
router.get("/", (0, safeHandler_1.safeHandler)((_req, res) => {
    (0, respondOk_1.respondOk)(res, {
        customers: [],
        contacts: [],
        totalCustomers: 0,
        totalContacts: 0,
    });
}));
router.get("/customers", (0, safeHandler_1.safeHandler)((req, res) => {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 25;
    (0, respondOk_1.respondOk)(res, {
        customers: [],
        total: 0,
    }, {
        page,
        pageSize,
    });
}));
router.get("/contacts", (0, safeHandler_1.safeHandler)((req, res) => {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 25;
    (0, respondOk_1.respondOk)(res, {
        contacts: [],
        total: 0,
    }, {
        page,
        pageSize,
    });
}));
router.get("/timeline", (0, safeHandler_1.safeHandler)(timeline_controller_1.handleListCrmTimeline));
router.get("/web-leads", support_controller_1.SupportController.fetchWebLeads);
exports.default = router;
