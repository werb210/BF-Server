// BF_SERVER_SBA_TRIGGER_v97
// Everything for SBA signing was built by v95/v96 and nothing ever called it:
// createSbaSigningSessions had no caller, so no applicant was ever sent a link,
// the dispatch gate blocked forever and no package could ship. This is the
// missing trigger.
//
// Two ways in, deliberately:
//   1. automatic - when the last required SBA form is submitted
//   2. manual    - a staff route, for re-sending or for a deal where staff want
//                  to review the answers before a federal form goes out
import { dbQuery } from "../../db.js";
import { createSbaSigningSessions } from "./sbaSigning.js";
import { resolveSbaOwners, ownerFingerprint } from "./sbaOwners.js";
import { logInfo } from "../../observability/logger.js";

/** Is this an SBA deal at all? Non-SBA applications must not be gated. */
// BF_SERVER_BLOCK_v455_SEND_FOLLOWUP - application_lender_selections has no
// lender_product_id column, so this always errored to 0. The selected product
// id lives in lender_submissions.lender_id (see the portal Send).
export async function isSbaApplication(applicationId: string): Promise<boolean> {
  const r = await dbQuery<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM lender_submissions s
       JOIN lender_products p ON p.id::text = s.lender_id::text
      WHERE s.application_id::text = ($1)::text
        AND upper(COALESCE(p.type,'')) IN ('SBA','SBA_GOVERNMENT')`,
    [applicationId],
  ).catch(() => ({ rows: [{ n: "0" }] }));
  if (Number(r.rows[0]?.n ?? 0) > 0) return true;

  // Fallback for an application that has not been matched to a product yet:
  // the wizard records the SBA / Start-up purpose on the kyc slice.
  const a = await dbQuery<{ purpose: string | null }>(
    `SELECT metadata->'kyc'->>'purposeOfFunds' AS purpose
       FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [applicationId],
  ).catch(() => ({ rows: [] as Array<{ purpose: string | null }> }));
  const p = String(a.rows[0]?.purpose ?? "").toLowerCase();
  return p.includes("sba") || p.includes("start up") || p.includes("start-up");
}

/** Which SBA forms must be in before signing can open. */
export async function sbaFormsComplete(applicationId: string): Promise<{ complete: boolean; missing: string[] }> {
  const owners = await resolveSbaOwners(applicationId);

  // BF_SERVER_SBA_OWNER_CAPACITY_v105
  // Form 1919 has five owner blocks and sbaFormBuilder truncates to that with
  // owners.slice(0, MAX_OWNERS); the client registers Form 413 renderers up to
  // sba_form_413_owner_5. A sixth 20%+ owner was therefore dropped from the 1919
  // - a false statement on a federal form - while this gate still demanded their
  // 413, which had no renderer and could never be submitted. Truncated document,
  // permanent stall, nothing logged anywhere.
  //
  // The paper form is the hard constraint and cannot be widened from here, so
  // the overflow is surfaced instead of swallowed: SBA_OVERFLOW is reported as a
  // missing item, which holds the file and shows staff exactly why. Six-owner
  // deals need a paper addendum and a human.
  const OWNER_CAPACITY = 5;
  const overflow = owners.filter((o) => o.index > OWNER_CAPACITY);
  if (overflow.length > 0) {
    logInfo("sba_owner_capacity_exceeded", {
      applicationId,
      owners: owners.length,
      capacity: OWNER_CAPACITY,
      overflowIndexes: overflow.map((o) => o.index),
    });
  }

  const within = owners.filter((o) => o.index <= OWNER_CAPACITY);
  const required = [
    "sba_form_1919",
    ...within.map((o) => (o.index <= 1 ? "sba_form_413" : `sba_form_413_owner_${o.index}`)),
    ...(overflow.length > 0 ? [`SBA_OVERFLOW:${overflow.length}_owners_over_capacity_${OWNER_CAPACITY}`] : []),
  ];
  const r = await dbQuery<{ doc_type: string; owner_fingerprint: string | null }>(
    `SELECT doc_type, owner_fingerprint FROM application_form_responses
      WHERE application_id::text = ($1)::text AND submitted_at IS NOT NULL`,
    [applicationId],
  ).catch(() => ({ rows: [] as Array<{ doc_type: string; owner_fingerprint: string | null }> }));

  // BF_SERVER_SBA_OWNER_IDENTITY_v104
  // A submitted 413 counts only if it was filled for the owner who currently
  // holds that position. Owner indices are positional, so a shareholder added or
  // removed mid-flow shifts everyone below and would otherwise hand one owner's
  // personal financial statement to another. A response with no fingerprint
  // predates this and is accepted as-is rather than forcing a re-ask.
  const expected = new Map<string, string>();
  for (const o of owners) {
    expected.set(o.index <= 1 ? "sba_form_413" : `sba_form_413_owner_${o.index}`, ownerFingerprint(o));
  }

  const have = new Set<string>();
  for (const row of r.rows) {
    const key = String(row.doc_type);
    const want = expected.get(key);
    const got = row.owner_fingerprint ? String(row.owner_fingerprint) : null;
    if (want && got && want !== got) {
      logInfo("sba_form_owner_changed", { applicationId, docType: key });
      continue;
    }
    have.add(key);
  }
  const missing = required.filter((k) => !have.has(k));
  return { complete: missing.length === 0, missing };
}

/** Open signing if, and only if, everything is in and nothing is open already. */
export async function maybeStartSbaSigning(applicationId: string): Promise<{
  started: boolean; reason?: string; links?: Array<{ ownerIndex: number; name: string; email: string; url: string | null }>;
}> {
  if (!(await isSbaApplication(applicationId))) return { started: false, reason: "not_sba" };
  const existing = await dbQuery<{ n: string }>(
    `SELECT COALESCE(jsonb_array_length(metadata->'sba_signnow'), 0)::text AS n
       FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [applicationId],
  ).catch(() => ({ rows: [{ n: "0" }] }));
  if (Number(existing.rows[0]?.n ?? 0) > 0) return { started: false, reason: "already_sent" };
  const { complete, missing } = await sbaFormsComplete(applicationId);
  if (!complete) return { started: false, reason: `waiting_on:${missing.join(",")}` };
  const links = await createSbaSigningSessions(applicationId);
  logInfo("sba_signing_started", { applicationId, envelopes: links.length });
  return { started: true, links };
}

/** Force a fresh set of envelopes. Used by the staff re-send route. */
export async function restartSbaSigning(applicationId: string) {
  await dbQuery(
    `UPDATE applications SET metadata = metadata - 'sba_signnow', updated_at = now()
      WHERE id::text = ($1)::text`,
    [applicationId],
  ).catch(() => {});
  return createSbaSigningSessions(applicationId);
}

// BF_SERVER_SBA_ONE_SIGNING_v758 - staff press "Send for signing". Every owner gets ONE signing: their copy of
// the Boreal application plus their SBA forms (1919 for owner 1, 912, 4506-C per IVES lender, 413). Owner 1 is
// texted and emailed to sign in the client portal; owners 2+ are emailed by SignNow.
export type SendForSigningResult = {
  ok: boolean; reason?: string; missing?: string[];
  owners?: Array<{ ownerIndex: number; name: string; email: string; started: boolean; delivery: string }>;
  notice?: { sms: boolean; email: boolean };
};
export async function sendSbaForSigning(applicationId: string): Promise<SendForSigningResult> {
  if (!(await isSbaApplication(applicationId))) return { ok: false, reason: "not_sba" };
  const { complete, missing } = await sbaFormsComplete(applicationId);
  if (!complete) return { ok: false, reason: "forms_incomplete", missing };
  await dbQuery(
    `UPDATE applications SET metadata = metadata - 'sba_signnow', updated_at = now() WHERE id::text = ($1)::text`,
    [applicationId],
  ).catch((err: any) => { console.warn("[sba_send] could not clear old envelopes", { applicationId, message: err?.message }); });
  const links = await createSbaSigningSessions(applicationId, { includeApplication: true });
  const owners = links.map((l) => ({ ownerIndex: l.ownerIndex, name: l.name, email: l.email, started: Boolean(l.email) && (l.ownerIndex > 1 || Boolean(l.url)), delivery: l.ownerIndex === 1 ? "client portal" : "SignNow email" }));
  const notice = await notifyOwnerOne(applicationId);
  logInfo("sba_send_for_signing", { applicationId, owners: owners.length, started: owners.filter((o) => o.started).length });
  return { ok: owners.some((o) => o.started), reason: owners.some((o) => o.started) ? undefined : "no_envelopes_created", owners, notice };
}

async function notifyOwnerOne(applicationId: string): Promise<{ sms: boolean; email: boolean }> {
  const out = { sms: false, email: false };
  const portal = "https://client.boreal.financial";
  try {
    const owners = await resolveSbaOwners(applicationId);
    const o1: any = owners.find((o) => o.index === 1);
    const phone = String(o1?.homePhone ?? o1?.phone ?? "").trim();
    if (phone) {
      // BF_SERVER_SBA_NOTICE_APP_FIRST_v781 - like every other client notice: the Boreal app first if installed, else SMS.
      const { pushToClientApp } = await import("../../services/notifications/notifyClient.js");
      const inApp = await pushToClientApp({ phone, applicationId, kind: "sba_ready_to_sign", sms: "", title: "Ready to sign", body: "Your application and SBA forms are ready to sign.", categoryId: "APPLICATION_UPDATE" });
      if (!inApp) {
        const { sendSms } = await import("../../modules/notifications/sms.service.js");
        await sendSms({ to: phone, message: `Boreal Financial: your application and SBA forms are ready to sign. Sign in at ${portal} and tap "Sign your application documents". Reply STOP to opt out.` });
        out.sms = true;
      } else {
        (out as any).app = true;
      }
    }
  } catch (err) { console.warn("[sba_send] owner 1 text failed", { applicationId, message: err instanceof Error ? err.message : String(err) }); }
  try {
    const { resolveClientEmail } = await import("../../services/clientEmail.js");
    const r = await resolveClientEmail(applicationId);
    if (r.email) {
      const { sendTransactional } = await import("../../services/sendgridService.js");
      const hi = r.firstName ? `Hi ${r.firstName},` : "Hello,";
      const sent = await sendTransactional({ to: r.email, subject: "Your application and SBA forms are ready to sign", html: `<p>${hi}</p><p>Your Boreal Financial application and SBA forms are ready to sign, all in one place.</p><p><a href="${portal}">Sign in to your client portal</a> and tap <strong>Sign your application documents</strong>.</p><p>Boreal Financial</p>` });
      out.email = sent.ok;
    }
  } catch (err) { console.warn("[sba_send] owner 1 email failed", { applicationId, message: err instanceof Error ? err.message : String(err) }); }
  return out;
}
