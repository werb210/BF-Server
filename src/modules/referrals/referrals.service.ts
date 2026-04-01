import { randomUUID } from "crypto";
import { pool } from "../../db";
import { createCompany } from "../crm/companies.repo";
import { createContact } from "../crm/contacts.repo";

export type ReferralPayload = {
  businessName: string;
  contactName: string;
  website: string | null;
  email: string | null;
  phone: string | null;
  referrerId: string | null;
};

export type ReferralResult = {
  companyId: string;
  contactId: string;
};

export async function submitReferral(
  payload: ReferralPayload
): Promise<ReferralResult> {
  const client = await pool.connect();
  try {
    await client.runQuery("begin");
    const companyId = randomUUID();
    const contactId = randomUUID();

    await createCompany({
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

    await createContact({
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

    await client.runQuery("commit");
    return { companyId, contactId };
  } catch (error) {
    await client.runQuery("rollback");
    throw error;
  } finally {
    client.release();
  }
}
