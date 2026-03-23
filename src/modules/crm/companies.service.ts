import { type CompanyRepoRow, findCompanyById, listCompanies } from "./companies.repo";

export type CompanyOwner = {
  id: string;
  email: string | null;
  phone: string | null;
};

export type CompanyRecord = {
  id: string;
  name: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  status: string | null;
  ownerId: string | null;
  referrerId: string | null;
  owner: CompanyOwner | null;
};

function normalizeCompany(row: CompanyRepoRow): CompanyRecord {
  const owner =
    row.owner_record_id !== null
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

export async function fetchCompanies(): Promise<CompanyRecord[]> {
  const rows = await listCompanies();
  if (rows.length === 0) {
    return [];
  }
  return rows.map((row) => normalizeCompany(row));
}

export async function fetchCompanyById(companyId: string): Promise<CompanyRecord | null> {
  const row = await findCompanyById({ companyId });
  if (!row) {
    return null;
  }
  return normalizeCompany(row);
}
