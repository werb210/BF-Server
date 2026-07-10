import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { creditBiReferralConversion } from "../modules/referrals/referralConversions.service.js";

const router = Router();

router.post(
  "/from-bi",
  requireAuth,
  requireCapability([CAPABILITIES.APPLICATION_CREATE]),
  safeHandler(async (req: any, res: any) => {
    const body = req.body ?? {};
    const refCode = typeof body.ref_code === "string" ? body.ref_code.trim() : typeof body.refCode === "string" ? body.refCode.trim() : "";
    const externalApplicationId = typeof body.bi_application_id === "string" ? body.bi_application_id.trim() : typeof body.externalApplicationId === "string" ? body.externalApplicationId.trim() : "";
    if (!refCode || !externalApplicationId) {
      res.status(400).json({ status: "error", message: "ref_code_and_bi_application_id_required" });
      return;
    }
    const dealAmount = Number.isFinite(Number(body.deal_amount)) ? Number(body.deal_amount) : null;
    const conversion = await creditBiReferralConversion({ refCode, externalApplicationId, dealAmount });
    res.status(200).json({ status: "ok", data: { conversionId: conversion?.id ?? null } });
  }),
);

export default router;
