"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const capabilities_1 = require("../auth/capabilities");
const safeHandler_1 = require("../middleware/safeHandler");
const respondOk_1 = require("../utils/respondOk");
const referrals_service_1 = require("../modules/referrals/referrals.service");
const errors_1 = require("../middleware/errors");
const router = (0, express_1.Router)();
const referralSchema = zod_1.z.object({
    businessName: zod_1.z.string().min(1),
    contactName: zod_1.z.string().min(1),
    website: zod_1.z.string().url().optional().or(zod_1.z.literal("")),
    email: zod_1.z.string().email().optional().or(zod_1.z.literal("")),
    phone: zod_1.z.string().optional().or(zod_1.z.literal("")),
});
router.use(auth_1.requireAuth);
router.use((0, auth_1.requireCapability)([capabilities_1.CAPABILITIES.APPLICATION_CREATE]));
router.post("/", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const parsed = referralSchema.safeParse(req.body);
    if (!parsed.success) {
        throw new errors_1.AppError("invalid_payload", "Invalid referral payload.", 400);
    }
    const website = parsed.data.website?.trim() || null;
    const email = parsed.data.email?.trim() || null;
    const phone = parsed.data.phone?.trim() || null;
    const result = await (0, referrals_service_1.submitReferral)({
        businessName: parsed.data.businessName.trim(),
        contactName: parsed.data.contactName.trim(),
        website,
        email,
        phone,
        referrerId: req.user?.userId ?? null,
    });
    res.status(201);
    (0, respondOk_1.respondOk)(res, result);
}));
exports.default = router;
