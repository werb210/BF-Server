// BF_SERVER_v857_SIGNING_NOTIFY
// "Send for signing" tells every signer who still has to sign, every time it is pressed, and reports exactly what
// happened to each of them.
//
// Before v857 the button re-used the cached SignNow session and sent nothing: Owner 1 was only ever texted when the
// session was first built (and only if they had ticked "Text me updates"), was never emailed, and partners were told
// nothing until Owner 1 had signed. The portal still showed "Signing sent".
//
// Now, for each signer who has not signed:
//   - Owner 1 (the applicant) gets an email and a text with a link that opens the client portal at the signing step.
//   - Owners 2..N get an email and a text with their own signing link (/api/signing/owner/<token>). The link never
//     expires: each click mints a fresh SignNow link (SignNow caps those at 45 minutes). SignNow signs owners in order,
//     so until Owner 1 has signed the link shows a page saying who signs first.
//   - Email always goes (signing a submitted application is transactional; SendGrid's transactional send bypasses
//     marketing unsubscribes, as for fee agreements). A text goes only when the number said yes to "Text me updates"
//     (BF_SERVER_v809_SMS_UPDATES_CONSENT, which names signing reminders) and has not replied STOP. When a text is not
//     sent the reason is returned so the portal shows it; nothing is skipped silently.
import crypto from "node:crypto";

export type SignerSpec = { index: number; role: string; name: string | null; email: string | null; phone: string | null };
export type ChannelResult = { to: string | null; status: "sent" | "failed" | "skipped"; at: string | null; reason: string | null };
export type SignerNotice = {
  index: number;
  role: string;
  name: string | null;
  isApplicant: boolean;
  alreadySigned: boolean;
  waitingFor: string | null;
  email: ChannelResult;
  sms: ChannelResult;
};
export type NotifyResult = { at: string; allSigned: boolean; signers: SignerNotice[]; error?: string };

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
type InputsLike = {
  applicantEmail?: string | null;
  applicantName?: string | null;
  owners: Array<{ firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null } | null | undefined>;
};

export type NotifyDeps = {
  query: Query;
  loadInputs: (applicationId: string) => Promise<InputsLike>;
  signerComplete: (groupId: string, email: string) => Promise<boolean>;
  sendEmail: (m: { to: string; subject: string; html: string; text: string; applicationId: string }) => Promise<{ ok: boolean; error?: string }>;
  sendSms: (m: { to: string; text: string; kind: string; applicationId: string }) => Promise<void>;
};

export const SIGNING_SMS_REASONS: Record<string, string> = {
  no_phone: "no mobile number on file",
  no_consent: "this number has not said yes to \"Text me updates\" (the checkbox when the client signs in), which signing texts need",
  opted_out: "this number replied STOP to Boreal texts",
  lookup_failed: "the text consent check failed, so no text was sent",
};

// ---------------------------------------------------------------------------------------------------- small helpers
export function phone10(raw: unknown): string {
  const d = String(raw ?? "").replace(/[^0-9]/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}
export function phoneE164(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const p = phone10(s);
  if (!p) return null;
  return s.startsWith("+") ? "+" + s.replace(/[^0-9]/g, "") : "+1" + p;
}
export function displayPhone(raw: unknown): string | null {
  const p = phone10(raw);
  return p ? "(" + p.slice(0, 3) + ") " + p.slice(3, 6) + "-" + p.slice(6) : null;
}
function clean(v: unknown): string | null {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s ? s : null;
}
export function esc(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function firstName(name: string | null): string | null {
  return name ? name.split(" ")[0] || null : null;
}
function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

// ------------------------------------------------------------------------------------------------------ the signers
/** Every owner who signs, in SignNow role order (Owner 1 = the applicant, with the CRM email), as the session builds them. */
export function signersFromInputs(inputs: InputsLike): SignerSpec[] {
  const owners = Array.isArray(inputs?.owners) ? inputs.owners : [];
  const out: SignerSpec[] = [{
    index: 1,
    role: "Owner 1",
    name: clean(inputs?.applicantName) ?? clean([owners[0]?.firstName, owners[0]?.lastName].filter(Boolean).join(" ")),
    email: clean(inputs?.applicantEmail) ?? clean(owners[0]?.email),
    phone: clean(owners[0]?.phone),
  }];
  owners.slice(1).forEach((o, i) => {
    out.push({
      index: i + 2,
      role: "Owner " + (i + 2),
      name: clean([o?.firstName, o?.lastName].filter(Boolean).join(" ")),
      email: clean(o?.email),
      phone: clean(o?.phone),
    });
  });
  return out;
}

/** Changes whenever a signer's name, email or phone changes, so a document built for other details is never re-used. */
export function signerFingerprint(signers: SignerSpec[]): string {
  const norm = signers
    .map((s) => [s.role, (s.name ?? "").toLowerCase(), (s.email ?? "").toLowerCase(), phone10(s.phone)].join("|"))
    .join("\n");
  return "v857:" + crypto.createHash("sha256").update(norm).digest("hex").slice(0, 40);
}

// ------------------------------------------------------------------------------------------------------- the links
function linkSecret(): string | null {
  const s = String(process.env.SIGNING_LINK_SECRET || process.env.JWT_SECRET || "");
  return s.length >= 10 ? s : null;
}
function macFor(applicationId: string, index: number, email: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update("v857|" + applicationId + "|" + index + "|" + email.trim().toLowerCase()).digest("base64url");
}
/** The applicant signs in the client portal; ?sign=1 opens the signing step once they are signed in. */
export function applicantSigningUrl(applicationId: string): string {
  const base = String(process.env.CLIENT_URL || "https://client.boreal.financial").replace(/\/+$/, "");
  return base + "/application/" + encodeURIComponent(applicationId) + "?sign=1";
}
/** Owner 2..N's own signing link. Bound to the application, the owner slot and that owner's email. */
export function ownerSigningUrl(applicationId: string, index: number, email: string): string | null {
  const secret = linkSecret();
  if (!secret || !email || index < 2) return null;
  const base = String(process.env.PUBLIC_BASE_URL || "https://server.boreal.financial").replace(/\/+$/, "");
  return base + "/api/signing/owner/" + applicationId + "." + index + "." + macFor(applicationId, index, email, secret);
}
const TOKEN_RE = /^([0-9a-fA-F-]{8,64})\.(\d{1,2})\.([A-Za-z0-9_-]{43})$/;
export function parseOwnerSigningToken(token: string): { applicationId: string; index: number; mac: string } | null {
  const m = TOKEN_RE.exec(String(token ?? ""));
  if (!m) return null;
  const index = Number(m[2]);
  if (!Number.isInteger(index) || index < 2) return null;
  return { applicationId: m[1]!, index, mac: m[3]! };
}
function macMatches(applicationId: string, index: number, email: string | null, mac: string): boolean {
  const secret = linkSecret();
  if (!secret || !email) return false;
  const want = Buffer.from(macFor(applicationId, index, email, secret));
  const got = Buffer.from(mac);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ---------------------------------------------------------------------------------------------------------- consent
export async function signingSmsGate(phone: unknown, query: Query): Promise<{ allowed: true } | { allowed: false; reason: keyof typeof SIGNING_SMS_REASONS }> {
  const p = phone10(phone);
  if (!p) return { allowed: false, reason: "no_phone" };
  try {
    const r = await query(
      `SELECT (SELECT s.consent FROM sms_updates_consents s WHERE s.phone10 = $1 LIMIT 1) AS v857_consent,
              EXISTS (SELECT 1 FROM contacts c
                       WHERE COALESCE(c.sms_opt_out, false) = true
                         AND right(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 10) = $1) AS v857_opted_out`,
      [p],
    );
    const row = r.rows[0] ?? {};
    if (row.v857_opted_out === true) return { allowed: false, reason: "opted_out" };
    if (row.v857_consent !== true) return { allowed: false, reason: "no_consent" };
    return { allowed: true };
  } catch (err) {
    console.warn("[signing-notify] sms consent lookup failed", { message: errText(err) });
    return { allowed: false, reason: "lookup_failed" };
  }
}

// --------------------------------------------------------------------------------------------------------- messages
function applicantMessage(name: string | null, business: string, link: string, phoneShown: string | null) {
  const hi = firstName(name) ? "Hi " + firstName(name) + "," : "Hello,";
  const signIn = phoneShown ? "Sign in with your mobile number (" + phoneShown + ") and the signing step opens." : "Sign in with your mobile number and the signing step opens.";
  return {
    subject: "Please sign your Boreal Financial application",
    html: "<p>" + esc(hi) + "</p><p>Your Boreal Financial application for " + esc(business) + " is ready for your signature.</p>"
      + "<p><a href=\"" + esc(link) + "\">Open your client portal to review and sign</a></p><p>" + esc(signIn) + "</p>"
      + "<p>Questions? Call (866) 631-8939.</p>",
    text: hi + "\n\nYour Boreal Financial application for " + business + " is ready for your signature.\n\nReview and sign: " + link + "\n" + signIn + "\n\nQuestions? Call (866) 631-8939.",
    sms: hi + " your Boreal Financial application is ready for your signature. Review and sign: " + link + " (sign in with this phone number). Reply STOP to opt out.",
  };
}
function ownerMessage(name: string | null, business: string, link: string, waitingFor: string | null) {
  const hi = firstName(name) ? "Hi " + firstName(name) + "," : "Hello,";
  const lead = waitingFor
    ? waitingFor + " signs first. As soon as they have, this link opens your documents (we will also email you then):"
    : "Please review and sign using your own secure link:";
  return {
    subject: "Your signature is needed: Boreal Financial application for " + business,
    html: "<p>" + esc(hi) + "</p><p>You are listed as an owner of " + esc(business) + " on its Boreal Financial application, so your signature is needed.</p>"
      + "<p>" + esc(lead) + "</p><p><a href=\"" + esc(link) + "\">Review and sign</a></p>"
      + "<p>This link is unique to you; please do not forward it.</p><p>Questions? Call (866) 631-8939.</p>",
    text: hi + "\n\nYou are listed as an owner of " + business + " on its Boreal Financial application, so your signature is needed.\n\n" + lead + "\n" + link + "\n\nThis link is unique to you; please do not forward it.\n\nQuestions? Call (866) 631-8939.",
    sms: hi + " your signature is needed on the Boreal Financial application for " + business + ". "
      + (waitingFor ? waitingFor + " signs first, then this link opens your documents: " : "Review and sign: ") + link + " Reply STOP to opt out.",
  };
}

// ----------------------------------------------------------------------------------------------------- notify them
const skipped = (to: string | null, reason: string): ChannelResult => ({ to, status: "skipped", at: null, reason });

export async function notifySigners(applicationId: string, deps: NotifyDeps = defaultNotifyDeps, now: () => Date = () => new Date()): Promise<NotifyResult> {
  const at = now().toISOString();
  const r = await deps.query(
    `SELECT signnow_app_signed_at, metadata->'signnow_embedded' AS v857_embedded,
            COALESCE(NULLIF(metadata->'business'->>'legalName', ''), NULLIF(metadata->'business'->>'businessName', ''), name) AS v857_business
       FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [applicationId],
  );
  const row = r.rows[0];
  if (!row) return { at, allSigned: false, signers: [], error: "application_not_found" };
  if (row.signnow_app_signed_at) return { at, allSigned: true, signers: [] };
  const groupId = row.v857_embedded && typeof row.v857_embedded === "object" ? String(row.v857_embedded.group_id ?? "") : "";
  const business = clean(row.v857_business) ?? "your business";
  const signers = signersFromInputs(await deps.loadInputs(applicationId));

  const done: boolean[] = [];
  for (const s of signers) {
    let complete = false;
    if (groupId && s.email) {
      try { complete = await deps.signerComplete(groupId, s.email); }
      catch (err) { console.warn("[signing-notify] signer status check failed", { applicationId, role: s.role, message: errText(err) }); }
    }
    done.push(complete);
  }
  const owner1Name = signers[0]?.name ?? "The applicant";

  const out: SignerNotice[] = [];
  let owner1Texted = false;
  for (let i = 0; i < signers.length; i++) {
    const s = signers[i]!;
    const base = { index: s.index, role: s.role, name: s.name, isApplicant: s.index === 1 };
    const shownPhone = displayPhone(s.phone);
    if (done[i]) {
      out.push({ ...base, alreadySigned: true, waitingFor: null, email: skipped(s.email, "already signed"), sms: skipped(shownPhone, "already signed") });
      continue;
    }
    if (s.index > 1 && !s.email) {
      const why = "no email address on file, so SignNow has no signer for this owner - add their email on the application, then press Send for signing again";
      out.push({ ...base, alreadySigned: false, waitingFor: null, email: skipped(null, why), sms: skipped(shownPhone, why) });
      continue;
    }
    const waitingFor = s.index > 1 && !done[0] ? owner1Name : null;
    const link = s.index === 1 ? applicantSigningUrl(applicationId) : ownerSigningUrl(applicationId, s.index, s.email ?? "");
    if (!link) {
      const why = "the signing link could not be made (SIGNING_LINK_SECRET / JWT_SECRET is not set on the server)";
      console.error("[signing-notify] no signing link", { applicationId, role: s.role });
      out.push({ ...base, alreadySigned: false, waitingFor, email: skipped(s.email, why), sms: skipped(shownPhone, why) });
      continue;
    }
    const msg = s.index === 1 ? applicantMessage(s.name, business, link, shownPhone) : ownerMessage(s.name, business, link, waitingFor);

    let email: ChannelResult;
    if (!s.email) {
      email = skipped(null, "no email address on file");
    } else {
      try {
        const sent = await deps.sendEmail({ to: s.email, subject: msg.subject, html: msg.html, text: msg.text, applicationId });
        email = sent.ok ? { to: s.email, status: "sent", at: now().toISOString(), reason: null } : { to: s.email, status: "failed", at: null, reason: "email could not be sent: " + (sent.error ?? "unknown error") };
      } catch (err) {
        email = { to: s.email, status: "failed", at: null, reason: "email could not be sent: " + errText(err) };
      }
      if (email.status === "failed") console.error("[signing-notify] email failed", { applicationId, role: s.role, reason: email.reason });
    }

    let sms: ChannelResult;
    const gate = await signingSmsGate(s.phone, deps.query);
    const e164 = phoneE164(s.phone);
    if (!gate.allowed || !e164) {
      sms = skipped(shownPhone, SIGNING_SMS_REASONS[gate.allowed ? "no_phone" : gate.reason] ?? "not sent");
    } else {
      try {
        await deps.sendSms({ to: e164, text: msg.sms, kind: s.index === 1 ? "owner1_signing" : "owner_signing", applicationId });
        sms = { to: shownPhone, status: "sent", at: now().toISOString(), reason: null };
        if (s.index === 1) owner1Texted = true;
      } catch (err) {
        sms = { to: shownPhone, status: "failed", at: null, reason: "the text could not be sent: " + errText(err) };
        console.error("[signing-notify] text failed", { applicationId, role: s.role, reason: sms.reason });
      }
    }
    out.push({ ...base, alreadySigned: false, waitingFor, email, sms });
  }

  const result: NotifyResult = { at, allSigned: false, signers: out };
  try {
    await deps.query(
      `UPDATE applications
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object('signing_notify', $2::jsonb)
                || CASE WHEN $3::boolean
                        THEN jsonb_build_object('owner1_signing_sms_at', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
                        ELSE '{}'::jsonb END,
              updated_at = now()
        WHERE id::text = ($1)::text -- BF_SERVER_v857_SIGNING_NOTIFY`,
      [applicationId, JSON.stringify(result), owner1Texted],
    );
  } catch (err) {
    // The messages went; only the record of them did not. Staff still see this result on the card.
    console.error("[signing-notify] record failed", { applicationId, message: errText(err) });
  }
  return result;
}

const defaultNotifyDeps: NotifyDeps = {
  async query(sql, params) {
    const { dbQuery } = await import("../db.js");
    return dbQuery(sql, params as any[]) as any;
  },
  async loadInputs(applicationId) {
    const { loadApplicationForPdf } = await import("./sendApplicationForSignature.js");
    return loadApplicationForPdf(applicationId) as any;
  },
  async signerComplete(groupId, email) {
    const { getSignerInviteComplete } = await import("./signnowClient.js");
    return getSignerInviteComplete(groupId, email);
  },
  async sendEmail(m) {
    const { sendgridConfigured, sendTransactional } = await import("../services/sendgridService.js");
    if (sendgridConfigured()) {
      const r = await sendTransactional({ to: m.to, subject: m.subject, html: m.html, customArgs: { kind: "signing_request", application_id: m.applicationId } });
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? "status " + r.status };
    }
    const { sendViaGraph } = await import("../services/email/graphSendService.js");
    const g = await sendViaGraph({ to: m.to, subject: m.subject, bodyHtml: m.html, bodyText: m.text });
    return g.ok ? { ok: true } : { ok: false, error: g.error };
  },
  async sendSms(m) {
    const { sendSms } = await import("../modules/notifications/sms.service.js");
    await sendSms({ to: m.to, message: m.text, track: { kind: m.kind, applicationId: m.applicationId } });
  },
};

// ------------------------------------------------------------------------------------- the partner's own link
export type LinkOutcome = { kind: "redirect"; url: string } | { kind: "page"; status: number; html: string };
export type LinkDeps = {
  query: Query;
  loadInputs: (applicationId: string) => Promise<InputsLike>;
  signerComplete: (groupId: string, email: string) => Promise<boolean>;
  mintLink: (groupId: string, inviteId: string, email: string) => Promise<{ url: string }>;
};

export function signingPage(title: string, body: string): string {
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    + "<meta name=\"robots\" content=\"noindex\"><title>" + esc(title) + " - Boreal Financial</title>"
    + "<style>body{margin:0;background:#f1f5f9;color:#0f172a;font:16px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif}"
    + "main{max-width:560px;margin:40px auto;padding:28px;background:#fff;border-radius:14px;box-shadow:0 6px 24px rgba(15,23,42,.08)}"
    + "h1{font-size:22px;margin:0 0 6px}.brand{font-weight:800;color:#1e3a8a;margin-bottom:18px}.muted{color:#475569;font-size:14px}</style></head>"
    + "<body><main><div class=\"brand\">Boreal Financial</div>" + body
    + "<p class=\"muted\" style=\"margin-top:24px\">Questions? Call (866) 631-8939 or email info@boreal.financial.</p></main></body></html>";
}
const page = (status: number, title: string, body: string): LinkOutcome => ({ kind: "page", status, html: signingPage(title, "<h1>" + esc(title) + "</h1>" + body) });

export async function resolveOwnerSigningLink(token: string, deps: LinkDeps = defaultLinkDeps): Promise<LinkOutcome> {
  const parsed = parseOwnerSigningToken(token);
  const invalid = page(404, "This signing link is not valid", "<p>Please use the newest signing email from Boreal Financial, or call us and we will send a new one.</p>");
  if (!parsed) return invalid;
  const r = await deps.query(
    `SELECT signnow_app_signed_at, metadata->'signnow_embedded' AS v857_embedded FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [parsed.applicationId],
  );
  const row = r.rows[0];
  if (!row) return invalid;
  const emb = row.v857_embedded && typeof row.v857_embedded === "object" ? row.v857_embedded : null;
  const stored = Array.isArray(emb?.signers) ? (emb.signers as SignerSpec[]) : null;
  const signers = stored ?? signersFromInputs(await deps.loadInputs(parsed.applicationId));
  const signer = signers.find((s) => Number(s.index) === parsed.index) ?? null;
  if (!signer || !macMatches(parsed.applicationId, parsed.index, signer.email, parsed.mac)) return invalid;
  if (row.signnow_app_signed_at) return page(200, "All signatures are in", "<p>Thank you. Every owner has signed this application, so there is nothing more to sign.</p>");
  if (!emb?.group_id || !emb?.invite_id) {
    return page(409, "Your documents are not ready yet", "<p>Boreal Financial has not prepared the documents for signing yet. We will email you as soon as they are ready.</p>");
  }
  try {
    if (await deps.signerComplete(String(emb.group_id), String(signer.email))) {
      return page(200, "You have already signed", "<p>Thank you, your signature is recorded. Boreal Financial will be in touch.</p>");
    }
  } catch (err) {
    console.warn("[signing-link] signer status check failed", { applicationId: parsed.applicationId, index: parsed.index, message: errText(err) });
  }
  try {
    const link = await deps.mintLink(String(emb.group_id), String(emb.invite_id), String(signer.email));
    return { kind: "redirect", url: link.url };
  } catch (err) {
    const m = errText(err);
    if (/19019002|current or prev steps/i.test(m)) {
      const first = clean(signers[0]?.name) ?? "The applicant";
      return page(200, "Almost your turn", "<p>" + esc(first) + " signs first. As soon as they have, this same link opens your documents, and we will email you too.</p>");
    }
    console.error("[signing-link] could not open the signing documents", { applicationId: parsed.applicationId, index: parsed.index, message: m });
    return page(502, "We could not open your documents", "<p>Please try again in a few minutes. If it keeps happening, call us and we will help.</p>");
  }
}

const defaultLinkDeps: LinkDeps = {
  query: defaultNotifyDeps.query,
  loadInputs: defaultNotifyDeps.loadInputs,
  signerComplete: defaultNotifyDeps.signerComplete,
  async mintLink(groupId, inviteId, email) {
    const { createEmbeddedGroupLink } = await import("./signnowClient.js");
    return createEmbeddedGroupLink(groupId, inviteId, email);
  },
};

// -------------------------------------------------------------------- historical records signed under the placeholder
/** A record kept with the OTP placeholder as its signer ("Unknown (application started)") shows the applicant's real name. */
export async function displaySignerName(applicationId: string, stored: string | null): Promise<string | null> {
  const { realName, resolveApplicantName } = await import("../services/applicantName.js");
  if (realName(stored)) return stored;
  const resolved = await resolveApplicantName(applicationId);
  return resolved.status === "ok" || resolved.status === "repaired" ? resolved.name.full : stored;
}
