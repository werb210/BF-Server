"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchContacts = fetchContacts;
const contacts_repo_1 = require("./contacts.repo");
function normalizeContact(row) {
    const owner = row.owner_record_id !== null
        ? {
            id: row.owner_record_id,
            email: row.owner_email ?? null,
            phone: row.owner_phone ?? null,
        }
        : null;
    const company = row.company_record_id !== null
        ? {
            id: row.company_record_id,
            name: row.company_name ?? null,
        }
        : null;
    return {
        id: row.id,
        name: row.name ?? null,
        email: row.email ?? null,
        phone: row.phone ?? null,
        status: row.status ?? null,
        companyId: row.company_id ?? null,
        ownerId: row.owner_id ?? null,
        referrerId: row.referrer_id ?? null,
        company,
        owner,
    };
}
async function fetchContacts(params) {
    const rows = await (0, contacts_repo_1.listContacts)({
        ...(params.companyId !== undefined ? { companyId: params.companyId } : {}),
    });
    if (rows.length === 0) {
        return [];
    }
    return rows.map((row) => normalizeContact(row));
}
