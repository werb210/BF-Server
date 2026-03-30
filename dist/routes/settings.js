"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const capabilities_1 = require("../auth/capabilities");
const safeHandler_1 = require("../middleware/safeHandler");
const respondOk_1 = require("../utils/respondOk");
const router = (0, express_1.Router)();
router.use(auth_1.requireAuth);
router.use((0, auth_1.requireCapability)([capabilities_1.CAPABILITIES.SETTINGS_READ]));
router.get("/", (0, safeHandler_1.safeHandler)((_req, res) => {
    (0, respondOk_1.respondOk)(res, { status: "ok" });
}));
router.get("/preferences", (0, safeHandler_1.safeHandler)((_req, res) => {
    (0, respondOk_1.respondOk)(res, { preferences: {} });
}));
router.get("/me", (0, safeHandler_1.safeHandler)((req, res) => {
    (0, respondOk_1.respondOk)(res, {
        userId: req.user?.userId ?? null,
        role: req.user?.role ?? null,
        phone: req.user?.phone ?? null,
    });
}));
exports.default = router;
