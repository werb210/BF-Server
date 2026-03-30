"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const capabilities_1 = require("../auth/capabilities");
const safeHandler_1 = require("../middleware/safeHandler");
const respondOk_1 = require("../utils/respondOk");
const router = (0, express_1.Router)();
router.use(auth_1.requireAuth);
router.use((0, auth_1.requireCapability)([capabilities_1.CAPABILITIES.COMMUNICATIONS_READ]));
router.get("/", (0, safeHandler_1.safeHandler)((_req, res) => {
    (0, respondOk_1.respondOk)(res, { status: "ok" });
}));
router.get("/messages", (0, safeHandler_1.safeHandler)((req, res) => {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 25;
    (0, respondOk_1.respondOk)(res, {
        messages: [],
        total: 0,
    }, {
        page,
        pageSize,
    });
}));
exports.default = router;
