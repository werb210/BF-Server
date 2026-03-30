"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listLenderProductRequirements = listLenderProductRequirements;
exports.fetchLenderProductRequirementById = fetchLenderProductRequirementById;
exports.countLenderProductRequirements = countLenderProductRequirements;
exports.countRequiredLenderProductRequirements = countRequiredLenderProductRequirements;
exports.createLenderProductRequirement = createLenderProductRequirement;
exports.updateLenderProductRequirement = updateLenderProductRequirement;
exports.deleteLenderProductRequirement = deleteLenderProductRequirement;
exports.createRequirementSeeds = createRequirementSeeds;
const crypto_1 = require("crypto");
const db_1 = require("../db");
async function listLenderProductRequirements(params) {
    const runner = params.client ?? db_1.pool;
    const requestedAmount = params.requestedAmount ?? null;
    const res = await runner.query(`select id,
            lender_product_id,
            document_type,
            required,
            min_amount,
            max_amount,
            created_at
     from lender_product_requirements
     where lender_product_id = $1
       and ($2::int is null
            or ((min_amount is null or $2 >= min_amount)
                and (max_amount is null or $2 <= max_amount)))
     order by created_at asc`, [params.lenderProductId, requestedAmount]);
    return res.rows;
}
async function fetchLenderProductRequirementById(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`select id,
            lender_product_id,
            document_type,
            required,
            min_amount,
            max_amount,
            created_at
     from lender_product_requirements
     where id = $1
     limit 1`, [params.id]);
    return res.rows[0] ?? null;
}
async function countLenderProductRequirements(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query("select count(*)::int as count from lender_product_requirements where lender_product_id = $1", [params.lenderProductId]);
    return res.rows[0]?.count ?? 0;
}
async function countRequiredLenderProductRequirements(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query("select count(*)::int as count from lender_product_requirements where lender_product_id = $1 and required = true", [params.lenderProductId]);
    return res.rows[0]?.count ?? 0;
}
async function createLenderProductRequirement(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`insert into lender_product_requirements
     (id, lender_product_id, document_type, required, min_amount, max_amount, created_at)
     values ($1, $2, $3, $4, $5, $6, now())
     returning id, lender_product_id, document_type, required, min_amount, max_amount, created_at`, [
        (0, crypto_1.randomUUID)(),
        params.lenderProductId,
        params.documentType,
        params.required,
        params.minAmount ?? null,
        params.maxAmount ?? null,
    ]);
    const record = res.rows[0];
    if (!record) {
        throw new Error("Failed to create lender product requirement.");
    }
    return record;
}
async function updateLenderProductRequirement(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`update lender_product_requirements
     set document_type = $1,
         required = $2,
         min_amount = $3,
         max_amount = $4
     where id = $5
     returning id, lender_product_id, document_type, required, min_amount, max_amount, created_at`, [params.documentType, params.required, params.minAmount ?? null, params.maxAmount ?? null, params.id]);
    return res.rows[0] ?? null;
}
async function deleteLenderProductRequirement(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`delete from lender_product_requirements
     where id = $1
     returning id, lender_product_id, document_type, required, min_amount, max_amount, created_at`, [params.id]);
    return res.rows[0] ?? null;
}
async function createRequirementSeeds(params) {
    if (params.requirements.length === 0) {
        return 0;
    }
    const runner = params.client ?? db_1.pool;
    const values = [];
    const placeholders = params.requirements
        .map((req, index) => {
        const offset = index * 6;
        values.push((0, crypto_1.randomUUID)(), params.lenderProductId, req.documentType, req.required, req.minAmount ?? null, req.maxAmount ?? null);
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, now())`;
    })
        .join(", ");
    await runner.query(`insert into lender_product_requirements
     (id, lender_product_id, document_type, required, min_amount, max_amount, created_at)
     values ${placeholders}`, values);
    return params.requirements.length;
}
