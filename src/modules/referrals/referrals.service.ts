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
    // BF_SERVER_CONTACT_DEDUPE_v73 - was always a fresh UUID, so referring
    // somebody already in the CRM created a second contact and split their
    // history. Look first; only mint an id if this is genuinely new.
    let contactId = randomUUID();
    let contactIsNew = true;
    const refEmail = (payload.email ?? "").trim();
    const refPhone = (payload.phone ?? "").trim();
    if (refEmail || refPhone) {
      try {
        const found = await client.query<{ id: string }>(
          `select id
             from contacts
            where ($1::text is not null and $1 <> '' and lower(email) = lower($1))
               or ($2::text is not null
                   and length(regexp_replace($2, '[^0-9]', '', 'g')) >= 10
                   and right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)
                     = right(regexp_replace($2, '[^0-9]', '', 'g'), 10))
            order by created_at asc
            limit 1`,
          [refEmail || null, refPhone || null],
        );
        if (found.rows[0]?.id) {
          // randomUUID() is typed as a UUID template literal; a value read back
          // from the database is a plain string and needs the cast.
          contactId = found.rows[0].id as `${string}-${string}-${string}-${string}-${string}`;
          contactIsNew = false;
        }
      } catch (err) {
        // A dedupe failure must not lose a referral. Fall through and create -
        // a duplicate is recoverable, a dropped referral is not.
        console.warn("[referrals] contact dedupe failed, creating new", String(err));
      }
    }
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

    // BF_SERVER_CONTACT_DEDUPE_v73 - an existing contact is tagged rather than
    // duplicated. The referrer link still lands on the right record because
    // contactId above is the existing one.
    if (!contactIsNew) {
      await client.query(
        `update contacts
            set tags = (select array(select distinct unnest(coalesce(tags,'{}') || array['referral'])))
          where id = $1`,
        [contactId],
      );
    }
    if (contactIsNew) await createContact({
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
