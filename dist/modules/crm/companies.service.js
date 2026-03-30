"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchCompanies = fetchCompanies;
exports.fetchCompanyById = fetchCompanyById;
const companies_repo_1 = require("./companies.repo");
function normalizeCompany(row) {
    const owner = row.owner_record_id !== null
        ? {
            id: row.owner_record_id,
            email: row.owner_email ?? null,
            phone: row.owner_phone ?? null,
        }
        : null;
    return {
        id: row.id,
        name: row.name ?? null,
        website: row.website ?? null,
        email: row.email ?? null,
        phone: row.phone ?? null,
        status: row.status ?? null,
        ownerId: row.owner_id ?? null,
        referrerId: row.referrer_id ?? null,
        owner,
    };
}
async function fetchCompanies() {
    const rows = await (0, companies_repo_1.listCompanies)();
    if (rows.length === 0) {
        return [];
    }
    return rows.map((row) => normalizeCompany(row));
}
async function fetchCompanyById(companyId) {
    const row = await (0, companies_repo_1.findCompanyById)({ companyId });
    if (!row) {
        return null;
    }
    return normalizeCompany(row);
}
