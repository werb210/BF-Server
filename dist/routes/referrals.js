import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";
import { submitReferral } from "../modules/referrals/referrals.service.js";
import { AppError } from "../middleware/errors.js";
const router = Router();
const referralSchema = z.object({
    businessName: z.string().min(1),
    contactName: z.string().min(1),
    website: z.string().url().optional().or(z.literal("")),
    email: z.string().email().optional().or(z.literal("")),
    phone: z.string().optional().or(z.literal("")),
});
router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.APPLICATION_CREATE]));
router.post("/", safeHandler(async (req, res, next) => {
    const parsed = referralSchema.safeParse(req.body);
    if (!parsed.success) {
        throw new AppError("invalid_payload", "Invalid referral payload.", 400);
    }
    const website = parsed.data.website?.trim() || null;
    const email = parsed.data.email?.trim() || null;
    const phone = parsed.data.phone?.trim() || null;
    const result = await submitReferral({
        businessName: parsed.data.businessName.trim(),
        contactName: parsed.data.contactName.trim(),
        website,
        email,
        phone,
        referrerId: req.user?.userId ?? null,
    });
    res.status(201);
    respondOk(res, result);
}));
export default router;
