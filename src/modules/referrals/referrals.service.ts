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
  startup?: boolean; // BF_SERVER_STARTUP_WAITLIST_v1 - add to the Startup Capital waitlist
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

    // BF_SERVER_STARTUP_WAITLIST_v1 - "Start-up funding" is a waitlist, not a silo: it sends
    // no intro now; the contact is tagged and messaged only when a Startup Capital lender
    // product is created. Real silos (BF/BI) still send their intros immediately.
    const realSilos = payload.silos ?? [];
    const effectiveSilos = realSilos.length ? realSilos : (payload.startup ? [] : ["BF"]);
    await client.query(
      `UPDATE contacts
          SET ref_code = $2,
              referral_silos = COALESCE($3::text[], referral_silos),
              referral_invite_message = COALESCE($4, referral_invite_message),
              referral_invited_at = COALESCE(referral_invited_at, now()),
              silo = COALESCE(silo, 'BF')
        WHERE id = $1`,
      [contactId, refCode, effectiveSilos, payload.message ?? null],
    );
    if (payload.startup) {
      await client.query(
        `UPDATE contacts SET tags = coalesce(tags, '{}') || ARRAY['startup_capital']::text[]
          WHERE id = $1 AND NOT ('startup_capital' = ANY(coalesce(tags, '{}')))`,
        [contactId],
      );
    }
    // BF_SERVER_REFERRAL_TAGGING_v1 - a referred contact was linked by referrer_id but
    // never tagged, so it was indistinguishable from any other prospect in the CRM.
    if (payload.referrerId) {
      await client.query(
        `UPDATE contacts SET tags = coalesce(tags, '{}') || ARRAY['referral']::text[]
          WHERE id = $1 AND NOT ('referral' = ANY(coalesce(tags, '{}')))`,
        [contactId],
      );
    }

    await client.query("commit");
    if (effectiveSilos.length > 0) {
      await sendReferralInviteSms({
        to: payload.phone,
        refCode,
        silos: effectiveSilos,
        message: payload.message ?? null,
        referrerName: payload.referrerName ?? null,
      }).catch(() => undefined);
    }
    return { companyId, contactId, refCode };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
