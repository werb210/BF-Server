import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { encryptSsnForInsert } from "../security/ssnCrypto.js";

export interface ContactRow {
  id: string;
  name: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  dob: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  address_country: string | null;
  ownership_percent: number | null;
  role: "applicant" | "partner" | "guarantor" | "other" | "unknown";
  is_primary_applicant: boolean;
  company_id: string | null;
  silo: string;
  owner_id: string | null;
  user_id: string | null;
  status: string;
}

export interface CreateContactInput {
  first_name: string;
  last_name: string;
  email?: string | null;
  phone?: string | null;
  dob?: string | null;
  ssn?: string | null;
  address_street?: string | null;
  address_city?: string | null;
  address_state?: string | null;
  address_zip?: string | null;
  address_country?: string | null;
  ownership_percent?: number | null;
  role?: "applicant" | "partner" | "guarantor" | "other" | "unknown";
  is_primary_applicant?: boolean;
  company_id?: string | null;
  silo: string;
  owner_id?: string | null;
}

export async function createContact(client: Pool | PoolClient, input: CreateContactInput): Promise<ContactRow> {
  const encryptedSsn = await encryptSsnForInsert(client, input.ssn ?? null);
  const id = crypto.randomUUID();
  const { rows } = await client.query<ContactRow>(
    `INSERT INTO contacts
      (id, name, first_name, last_name, email, phone, dob, ssn_encrypted, address_street, address_city, address_state,
       address_zip, address_country, ownership_percent, role, is_primary_applicant, company_id, silo, owner_id, user_id, status)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING id, name, first_name, last_name, email, phone, dob, address_street, address_city, address_state,
       address_zip, address_country, ownership_percent, role, is_primary_applicant, company_id, silo, owner_id, user_id, status, created_at`,
    [
      id,
      `${input.first_name} ${input.last_name}`.trim(),
      input.first_name,
      input.last_name,
      input.email ?? null,
      input.phone ?? null,
      input.dob ?? null,
      encryptedSsn,
      input.address_street ?? null,
      input.address_city ?? null,
      input.address_state ?? null,
      input.address_zip ?? null,
      input.address_country ?? null,
      input.ownership_percent ?? null,
      input.role ?? "unknown",
      input.is_primary_applicant === true,
      input.company_id ?? null,
      input.silo,
      input.owner_id ?? null,
      input.owner_id ?? null,
      "active",
    ]
  );
  return rows[0] as ContactRow;
}

export async function findOrCreateContactByEmailAndCompany(
  client: Pool | PoolClient,
  email: string,
  companyId: string,
  silo: string,
  fullInput: CreateContactInput
): Promise<{ row: ContactRow; created: boolean }> {
  const trimmedEmail = email.trim();
  // BF_SERVER_BLOCK_v725_CONTACT_DEDUP_EMAIL_OR_PHONE_v1 — dedup on the applicant's
  // stable identifiers (email OR phone) within the silo, independent of company.
  // Each submission creates a fresh company, so the old email+company match never
  // hit and every test produced a duplicate CRM contact. Match email/phone instead.
  const normPhone = String(fullInput.phone ?? "").replace(/\D/g, "");
  if (trimmedEmail || normPhone.length >= 7) {
    const { rows: idMatch } = await client.query<ContactRow>(
      `SELECT id, name, first_name, last_name, email, phone, dob, address_street, address_city, address_state,
         address_zip, address_country, ownership_percent, role, is_primary_applicant, company_id, silo, owner_id, user_id, status
       FROM contacts
       WHERE silo = $1
         AND ( ($2 <> '' AND lower(email) = lower($2))
            OR ($3 <> '' AND regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = $3) )
       LIMIT 1`,
      [silo, trimmedEmail, normPhone]
    );
    if (idMatch[0]) {
      return { row: idMatch[0], created: false };
    }
  }
  if (!trimmedEmail) {
    const row = await createContact(client, fullInput);
    return { row, created: true };
  }
  const { rows: existingRows } = await client.query<ContactRow>(
    `SELECT id, name, first_name, last_name, email, phone, dob, address_street, address_city, address_state,
       address_zip, address_country, ownership_percent, role, is_primary_applicant, company_id, silo, owner_id, user_id, status
     FROM contacts
     WHERE lower(email) = lower($1) AND company_id = $2 AND silo = $3
     LIMIT 1`,
    [trimmedEmail, companyId, silo]
  );
  if (existingRows[0]) {
    return { row: existingRows[0], created: false };
  }
  const row = await createContact(client, fullInput);
  return { row, created: true };
}
