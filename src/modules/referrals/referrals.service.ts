import { randomUUID } from "node:crypto";
import { pool } from "../../db.js";
import { createCompany } from "../crm/companies.repo.js";
import { createContact } from "../crm/contacts.repo.js";
import { mintReferralCode, sendReferralInviteSms } from "./referralInvite.js";

export type ReferralPayload = {
  businessName: string;
  contactName: string;
  website: string | null;
  email: string | null;
  phone: string | null;
  referrerId: string | null;
  silos?: string[];
  message?: string | null;
  referrerName?: string | null;
};

export type ReferralResult = {
  companyId: string;
  contactId: string;
  refCode: string;
};

export async function submitReferral(
  payload: ReferralPayload
): Promise<ReferralResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const companyId = randomUUID();
    const contactId = randomUUID();
    const refCode = mintReferralCode();

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

    await client.query(
      `UPDATE contacts
          SET ref_code = $2,
              referral_silos = COALESCE($3::text[], referral_silos),
              referral_invite_message = COALESCE($4, referral_invite_message),
              referral_invited_at = COALESCE(referral_invited_at, now()),
              silo = COALESCE(silo, 'BF')
        WHERE id = $1`,
      [contactId, refCode, payload.silos ?? ["BF"], payload.message ?? null],
    );

    await client.query("commit");
    await sendReferralInviteSms({
      to: payload.phone,
      refCode,
      silos: payload.silos ?? ["BF"],
      message: payload.message ?? null,
      referrerName: payload.referrerName ?? null,
    }).catch(() => undefined);
    return { companyId, contactId, refCode };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
