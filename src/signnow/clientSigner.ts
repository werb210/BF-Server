// BF_SERVER_v858_PARTNER_SIGNING
// Each owner signs their own documents in the client portal.
//
// Before v858, GET /api/client/signing-session always opened Owner 1's SignNow link: the route only checked that the
// signed-in phone belonged to someone on the application, then called getOrCreateEmbeddedSigningSession, which mints
// the link for the applicant's email. A partner (Poke Prod LLC: Elizabeth Cullen, 50%) who signed in with her own
// phone was handed Sean's signing link.
//
// Now the route works out WHO is signed in and answers for that person only:
//   - who: the OTP phone on the session (and an email claim, if the token ever carries one), matched against the
//     signers of the application (Owner 1 = the applicant, with the CRM contact's phone too; Owners 2..N from the
//     application, as the signing session builds them). A phone match wins over an email match, because co-owners
//     may share one inbox. Someone on the file who is not a signer is refused (403 not_a_signer).
//   - Owner 1: exactly the old path (getOrCreateEmbeddedSigningSession).
//   - Owner 2..N: their own link, minted for THEIR email on the cached document group. Before that: already signed ->
//     "signed"; an earlier owner has not signed -> not_ready / waiting_for_signer with that owner's name (SignNow signs
//     owners in order). The email used is the one the document was built for (v857's stored signer list, or the
//     owner_invite_queue every session writes); when that is no longer this person's email the document is stale and
//     nothing is minted (staff press Send for signing again).
//   - With v857 installed, the answer also carries that owner's never-expiring link (/api/signing/owner/<token>), so
//     the portal can open it outside the frame. Without v857 the field is simply absent.
// Nobody is ever given a link minted for another signer's email.

export type ClientIdentity = { phone10: string; email: string | null };
export type SignerRef = { index: number; role: string; name: string | null; isApplicant: boolean };
export type ClientSigningAnswer =
  | { kind: "refuse"; status: 403 | 404; error: "not_a_signer" | "application_not_found" }
  | { kind: "answer"; body: Record<string, unknown> };

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
type OwnerLike = { firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null } | null | undefined;
type InputsLike = { applicantEmail?: string | null; applicantName?: string | null; owners: OwnerLike[] };

export type ClientSignerDeps = {
  query: Query;
  loadInputs: (applicationId: string) => Promise<InputsLike>;
  ownerOneSession: (applicationId: string) => Promise<Record<string, unknown>>;
  isSba: (applicationId: string) => Promise<boolean>;
  signerComplete: (groupId: string, email: string) => Promise<boolean>;
  mintLink: (groupId: string, inviteId: string, email: string) => Promise<{ url: string; expiresAt: string | null }>;
  ownerLink: (applicationId: string, index: number, email: string) => Promise<string | null>;
};

type Signer = SignerRef & { email: string | null; phones: string[] };

function clean(v: unknown): string | null {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s ? s : null;
}
export function phone10(raw: unknown): string {
  const d = String(raw ?? "").replace(/[^0-9]/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}
function lower(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}
function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}
function ref(s: Signer): SignerRef {
  return { index: s.index, role: s.role, name: s.name, isApplicant: s.isApplicant };
}

/** The signers in SignNow role order, as embeddedSigningSession builds them (Owner 1 = applicant + CRM email). */
export function signersOf(inputs: InputsLike, applicantContactPhones: string[] = []): Signer[] {
  const owners = Array.isArray(inputs?.owners) ? inputs.owners : [];
  const o1phones = [phone10(owners[0]?.phone), ...applicantContactPhones.map(phone10)].filter(Boolean);
  const out: Signer[] = [{
    index: 1,
    role: "Owner 1",
    name: clean(inputs?.applicantName) ?? clean([owners[0]?.firstName, owners[0]?.lastName].filter(Boolean).join(" ")),
    email: clean(inputs?.applicantEmail) ?? clean(owners[0]?.email),
    phones: Array.from(new Set(o1phones)),
    isApplicant: true,
  }];
  owners.slice(1).forEach((o, i) => {
    const p = phone10(o?.phone);
    out.push({
      index: i + 2,
      role: "Owner " + (i + 2),
      name: clean([o?.firstName, o?.lastName].filter(Boolean).join(" ")),
      email: clean(o?.email),
      phones: p ? [p] : [],
      isApplicant: false,
    });
  });
  return out;
}

/**
 * Which signers the signed-in person is. Phone first: a phone match is the person. Email only when no phone matched,
 * and only an email that belongs to exactly one signer (co-owners who share an inbox are not told apart by email).
 */
export function matchSigners(signers: Signer[], phone: string, emails: string[]): Signer[] {
  const byPhone = phone ? signers.filter((s) => s.phones.includes(phone)) : [];
  if (byPhone.length) return byPhone;
  const want = new Set(emails.map(lower).filter(Boolean));
  if (!want.size) return [];
  const byEmail = signers.filter((s) => s.email && want.has(lower(s.email)));
  if (byEmail.length !== 1) return [];
  const only = byEmail[0]!;
  // the same address on two signers (shared inbox) is never enough on its own
  return signers.filter((s) => s.email && lower(s.email) === lower(only.email)).length === 1 ? [only] : [];
}

/** The email each owner slot was invited with when the cached document was built (v857 list, else the invite queue). */
function builtEmails(embedded: any, queue: any): Map<number, string> {
  const out = new Map<number, string>();
  const stored = Array.isArray(embedded?.signers) ? embedded.signers : null;
  if (stored) {
    for (const s of stored) if (Number(s?.index) >= 1 && clean(s?.email)) out.set(Number(s.index), String(s.email));
    return out;
  }
  if (Array.isArray(queue)) {
    for (const q of queue) if (Number(q?.index) >= 2 && clean(q?.email)) out.set(Number(q.index), String(q.email));
  }
  return out;
}

const WAITING = "waiting_for_signer";

export async function clientSigningSession(applicationId: string, who: ClientIdentity, deps: ClientSignerDeps = defaultClientSignerDeps): Promise<ClientSigningAnswer> {
  const app = await deps.query(
    `SELECT signnow_app_signed_at, metadata->'signnow_embedded' AS v858_embedded, metadata->'owner_invite_queue' AS v858_queue
       FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [applicationId],
  );
  const row = app.rows[0];
  if (!row) return { kind: "refuse", status: 404, error: "application_not_found" };

  // Everyone linked to the file with a phone or email: the applicant's CRM phone counts for Owner 1, and the emails on
  // the signed-in phone's own contact records identify a signer whose phone was never typed into the application.
  const people = await deps.query(
    `SELECT 'applicant' AS v858_role, c.phone, c.email
       FROM applications a
       JOIN contacts c ON c.id = COALESCE(a.contact_id,
            (SELECT p.contact_id FROM applications p WHERE p.id::text = a.parent_application_id::text))
      WHERE a.id::text = ($1)::text
     UNION ALL
     SELECT ac.role AS v858_role, c.phone, c.email
       FROM application_contacts ac
       JOIN contacts c ON c.id = ac.contact_id
      WHERE ac.application_id::text = ($1)::text`,
    [applicationId],
  );
  const applicantPhones = people.rows.filter((p) => String(p.v858_role) === "applicant").map((p) => String(p.phone ?? ""));
  const myEmails = [who.email ?? "", ...people.rows.filter((p) => who.phone10 && phone10(p.phone) === who.phone10).map((p) => String(p.email ?? ""))];

  const signers = signersOf(await deps.loadInputs(applicationId), applicantPhones);
  const mine = matchSigners(signers, who.phone10, myEmails);
  if (!mine.length) {
    console.warn("[client-signing] signed-in person is not a signer on this application", { applicationId, phoneLast4: who.phone10.slice(-4) });
    return { kind: "refuse", status: 403, error: "not_a_signer" };
  }
  const owner1Name = signers[0]?.name ?? "The applicant";
  if (row.signnow_app_signed_at) {
    return { kind: "answer", body: { status: "signed", signer: ref(mine[0]!), allSigned: true } };
  }

  // One phone listed for two owners (a shared phone) is both of them: work through them in signing order.
  let last: Record<string, unknown> | null = null;
  for (const me of mine) {
    const body = me.index === 1
      ? await ownerOne(applicationId, me, deps)
      : await ownerN(applicationId, me, signers, row, owner1Name, deps);
    last = body;
    if (body.status !== "signed") return { kind: "answer", body };
  }
  return { kind: "answer", body: last! };
}

async function ownerOne(applicationId: string, me: Signer, deps: ClientSignerDeps): Promise<Record<string, unknown>> {
  const r = await deps.ownerOneSession(applicationId);
  return { ...r, signer: ref(me) };
}

async function ownerN(applicationId: string, me: Signer, signers: Signer[], row: any, owner1Name: string, deps: ClientSignerDeps): Promise<Record<string, unknown>> {
  const base = { signer: ref(me) };
  if (await deps.isSba(applicationId)) {
    // SBA: every owner after the applicant signs their own SignNow envelope, which SignNow emails to them.
    return { ...base, status: "not_ready", reason: "signs_by_email" };
  }
  if (!me.email) return { ...base, status: "not_ready", reason: "no_signer_email" };
  const emb = row.v858_embedded && typeof row.v858_embedded === "object" ? row.v858_embedded : null;
  if (!emb?.group_id || !emb?.invite_id) {
    return { ...base, status: "not_ready", reason: "documents_not_ready", waitingFor: owner1Name };
  }
  const built = builtEmails(emb, row.v858_queue);
  const invited = built.get(me.index) ?? me.email;
  if (lower(invited) !== lower(me.email)) {
    // The document was built for someone else in this owner slot (or an older address): never mint that link.
    console.warn("[client-signing] signing document was built for other owner details; not opening it", { applicationId, index: me.index });
    return { ...base, status: "not_ready", reason: "signer_details_changed" };
  }
  const group = String(emb.group_id);
  const complete = async (email: string): Promise<boolean | null> => {
    try { return await deps.signerComplete(group, email); }
    catch (err) { console.warn("[client-signing] signer status check failed", { applicationId, message: errText(err) }); return null; }
  };
  if ((await complete(invited)) === true) return { ...base, status: "signed" };
  for (const s of signers) {
    if (s.index >= me.index) break;
    const email = built.get(s.index) ?? s.email;
    if (!email) continue;
    if ((await complete(email)) === false) return { ...base, status: "not_ready", reason: WAITING, waitingFor: s.name ?? s.role };
  }
  let ownerLink: string | null = null;
  try { ownerLink = await deps.ownerLink(applicationId, me.index, invited); }
  catch (err) { console.warn("[client-signing] owner link unavailable", { applicationId, message: errText(err) }); }
  try {
    const link = await deps.mintLink(group, String(emb.invite_id), invited);
    return { ...base, status: "ready", url: link.url, expiresAt: link.expiresAt, ...(ownerLink ? { ownerLink } : {}) };
  } catch (err) {
    const m = errText(err);
    if (/19019002|current or prev steps/i.test(m)) {
      return { ...base, status: "not_ready", reason: WAITING, waitingFor: owner1Name };
    }
    console.error("[client-signing] could not open the owner's signing documents", { applicationId, index: me.index, message: m });
    return { ...base, status: "error", reason: "signing_link_failed" };
  }
}

// v857 (the BF-Server SIGNING_NOTIFY block) adds src/signnow/signingNotify.ts with the never-expiring per-owner links. It
// may not be installed yet, so it is looked up at run time; when it is missing there is simply no ownerLink.
let v857Module: Promise<any | null> | null = null;
function loadV857(): Promise<any | null> {
  if (!v857Module) {
    const spec = "./signingNotify.js";
    v857Module = import(spec).then(
      (m: any) => (typeof m?.ownerSigningUrl === "function" ? m : null),
      (err: unknown) => {
        console.info("[client-signing] per-owner signing links (v857) are not installed", { message: errText(err) });
        return null;
      },
    );
  }
  return v857Module;
}

export const defaultClientSignerDeps: ClientSignerDeps = {
  async query(sql, params) {
    const { dbQuery } = await import("../db.js");
    return dbQuery(sql, params as any[]) as any;
  },
  async loadInputs(applicationId) {
    const { loadApplicationForPdf } = await import("./sendApplicationForSignature.js");
    return loadApplicationForPdf(applicationId) as any;
  },
  async ownerOneSession(applicationId) {
    const { getOrCreateEmbeddedSigningSession } = await import("./embeddedSigningSession.js");
    return (await getOrCreateEmbeddedSigningSession(applicationId)) as any;
  },
  async isSba(applicationId) {
    const { isSbaApplication } = await import("./sba/sbaTrigger.js");
    return isSbaApplication(applicationId);
  },
  async signerComplete(groupId, email) {
    const { getSignerInviteComplete } = await import("./signnowClient.js");
    return getSignerInviteComplete(groupId, email);
  },
  async mintLink(groupId, inviteId, email) {
    const { createEmbeddedGroupLink } = await import("./signnowClient.js");
    return createEmbeddedGroupLink(groupId, inviteId, email);
  },
  async ownerLink(applicationId, index, email) {
    const m = await loadV857();
    return m ? (m.ownerSigningUrl(applicationId, index, email) as string | null) : null;
  },
};
