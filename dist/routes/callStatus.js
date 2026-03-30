"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const roles_1 = require("../auth/roles");
const router = (0, express_1.Router)();
router.post("/status", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] }), async (req, res, next) => {
    const { callSid, status } = req.body;
    if (!callSid) {
        return res.status(400).json({ error: "callSid required" });
    }
    return res["json"]({ success: true, callSid, status: status ?? null });
});
exports.default = router;
