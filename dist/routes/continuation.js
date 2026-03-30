"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = require("node:crypto");
const express_1 = require("express");
const db_1 = require("../db");
const smsService_1 = require("../services/smsService");
const leadUpsert_service_1 = require("../modules/crm/leadUpsert.service");
const router = (0, express_1.Router)();
router.post("/", async (req, res, next) => {
    const data = (req.body ?? {});
    if (!data.companyName || !data.fullName || !data.email || !data.phone || !data.industry) {
        res.status(400).json({ error: "Missing required fields" });
        return;
    }
    const continuationId = (0, node_crypto_1.randomUUID)();
    const { rows } = await db_1.db.query(`
      insert into continuation (
        id,
        company_name,
        full_name,
        email,
        phone,
        industry,
        years_in_business,
        monthly_revenue,
        annual_revenue,
        ar_outstanding,
        existing_debt
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      returning *
    `, [
        continuationId,
        data.companyName,
        data.fullName,
        data.email,
        data.phone,
        data.industry,
        data.yearsInBusiness ?? null,
        data.monthlyRevenue ?? null,
        data.annualRevenue ?? null,
        data.arOutstanding ?? null,
        data.existingDebt ?? null,
    ]);
    await (0, leadUpsert_service_1.upsertCrmLead)({
        companyName: data.companyName,
        fullName: data.fullName,
        email: data.email,
        phone: data.phone,
        industry: data.industry,
        yearsInBusiness: data.yearsInBusiness,
        monthlyRevenue: data.monthlyRevenue,
        annualRevenue: data.annualRevenue,
        arOutstanding: data.arOutstanding,
        existingDebt: data.existingDebt,
        source: "capital_readiness",
        tags: ["readiness"],
        activityType: "capital_readiness_submission",
    });
    await (0, smsService_1.sendSMS)("+15878881837", `New Capital Readiness Lead: ${data.companyName} (${data.fullName})`);
    res["json"](rows[0]);
});
router.get("/by-email", async (req, res, next) => {
    const email = req.query.email;
    if (typeof email !== "string" || !email.trim()) {
        res.status(400).json({ error: "Missing email" });
        return;
    }
    const { rows } = await db_1.db.query(`
      select *
      from continuation
      where email = $1
      order by created_at desc
      limit 1
    `, [email]);
    if (!rows[0]) {
        res.status(404).json({});
        return;
    }
    res["json"](rows[0]);
});
router.get("/:id", async (req, res, next) => {
    const { id } = req.params;
    const { rows } = await db_1.db.query(`select * from continuation where id = $1 limit 1`, [id]);
    if (!rows[0]) {
        res.status(404).json({});
        return;
    }
    res["json"](rows[0]);
});
router.patch("/:id/mark-used", async (req, res, next) => {
    const { id } = req.params;
    await db_1.db.query(`
      update continuation
      set used_in_application = true
      where id = $1
    `, [id]);
    res["json"]({ success: true });
});
exports.default = router;
