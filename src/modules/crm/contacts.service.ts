import { type ContactRepoRow, listContacts } from "./contacts.repo";

export type ContactOwner = {
  id: string;
  email: string | null;
  phone: string | null;
};

export type ContactCompany = {
  id: string;
  name: string | null;
};

export type ContactRecord = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  status: string | null;
  companyId: string | null;
  ownerId: string | null;
  referrerId: string | null;
  company: ContactCompany | null;
  owner: ContactOwner | null;
};

function normalizeContact(row: ContactRepoRow): ContactRecord {
  const owner =
    row.owner_record_id !== null
      ? {
          id: row.owner_record_id,
          email: row.owner_email ?? null,
          phone: row.owner_phone ?? null,
        }
      : null;

  const company =
    row.company_record_id !== null
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

export async function fetchContacts(params: {
  companyId?: string | null;
}): Promise<ContactRecord[]> {
  const rows = await listContacts({
    ...(params.companyId !== undefined ? { companyId: params.companyId } : {}),
  });
  if (rows.length === 0) {
    return [];
  }
  return rows.map((row) => normalizeContact(row));
}
