import { findCompanyById, listCompanies } from "./companies.repo.js";
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
export async function fetchCompanies() {
    const rows = await listCompanies();
    if (rows.length === 0) {
        return [];
    }
    return rows.map((row) => normalizeCompany(row));
}
export async function fetchCompanyById(companyId) {
    const row = await findCompanyById({ companyId });
    if (!row) {
        return null;
    }
    return normalizeCompany(row);
}
