"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const capabilities_1 = require("../auth/capabilities");
const safeHandler_1 = require("../middleware/safeHandler");
const router = (0, express_1.Router)();
router.use(auth_1.requireAuth);
router.use((0, auth_1.requireCapability)([capabilities_1.CAPABILITIES.STAFF_OVERVIEW]));
router.get("/overview", (0, safeHandler_1.safeHandler)((_req, res) => {
    res["json"]({ ok: true });
}));
exports.default = router;
