"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitReferral = submitReferral;
const crypto_1 = require("crypto");
const db_1 = require("../../db");
const companies_repo_1 = require("../crm/companies.repo");
const contacts_repo_1 = require("../crm/contacts.repo");
async function submitReferral(payload) {
    const client = await db_1.pool.connect();
    try {
        await client.query("begin");
        const companyId = (0, crypto_1.randomUUID)();
        const contactId = (0, crypto_1.randomUUID)();
        await (0, companies_repo_1.createCompany)({
            id: companyId,
            name: payload.businessName,
            website: payload.website,
            email: payload.email,
            phone: payload.phone,
            status: "prospect",
            ownerId: null,
            referrerId: payload.referrerId,
            client,
        });
        await (0, contacts_repo_1.createContact)({
            id: contactId,
            name: payload.contactName,
            email: payload.email,
            phone: payload.phone,
            status: "prospect",
            companyId,
            ownerId: null,
            referrerId: payload.referrerId,
            client,
        });
        await client.query("commit");
        return { companyId, contactId };
    }
    catch (error) {
        await client.query("rollback");
        throw error;
    }
    finally {
        client.release();
    }
}
