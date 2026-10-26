// BF_SERVER_v858_PARTNER_SIGNING - each owner signs their own documents in the client portal.
// Poke Prod LLC: Sean Dwyer (Owner 1, the applicant) and Elizabeth Cullen (Owner 2, 50%). The database is faked by
// SQL content; SignNow is faked per signer email, so a link can only ever be minted for the email it names.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";
import { clientSigningSession, matchSigners, signersOf, type ClientSignerDeps } from "../clientSigner.js";

const APP = "5b3c2a10-0000-4000-8000-00000000a858";
const SEAN = { firstName: "Sean", lastName: "Dwyer", email: "sean@pokeprod.test", phone: "(587) 555-0141" };
const ELIZ = { firstName: "Elizabeth", lastName: "Cullen", email: "elizabeth@pokeprod.test", phone: "+1 403 555 0177" };
const THIRD = { firstName: "Tom", lastName: "Third", email: "tom@pokeprod.test", phone: "780-555-0190" };
const SEAN10 = "5875550141";
const ELIZ10 = "4035550177";
const TOM10 = "7805550190";
const STRANGER10 = "2505550100";

type World = {
  signedAt?: string | null;
  embedded?: any;
  queue?: any;
  people?: Array<{ v858_role: string; phone: string | null; email: string | null }>;
  owners?: any[];
  signed?: Set<string>;
  sba?: boolean;
  mintError?: Error;
};

function setup(w: World = {}) {
  const query = vi.fn(answerBySql([
    [/AS v858_embedded/, () => ({ rows: [{ signnow_app_signed_at: w.signedAt ?? null, v858_embedded: w.embedded === undefined ? { group_id: "grp-1", invite_id: "inv-1" } : w.embedded, v858_queue: w.queue ?? null }] })],
    [/AS v858_role/, () => ({ rows: w.people ?? [{ v858_role: "applicant", phone: "+15875550141", email: SEAN.email }, { v858_role: "partner", phone: "4035550177", email: ELIZ.email }] })],
  ]));
  const signed = w.signed ?? new Set<string>();
  const deps: ClientSignerDeps = {
    query,
    loadInputs: vi.fn(async () => ({ applicantName: "Sean Dwyer", applicantEmail: SEAN.email, owners: w.owners ?? [SEAN, ELIZ] })),
    ownerOneSession: vi.fn(async () => (signed.has(SEAN.email) ? { status: "signed" } : { status: "ready", url: "https://signnow.test/link/" + SEAN.email, expiresAt: null })),
    isSba: vi.fn(async () => w.sba === true),
    signerComplete: vi.fn(async (_g: string, email: string) => signed.has(email)),
    mintLink: vi.fn(async (_g: string, _i: string, email: string) => {
      if (w.mintError) throw w.mintError;
      return { url: "https://signnow.test/link/" + email, expiresAt: "2026-10-25T20:00:00Z" };
    }),
    ownerLink: vi.fn(async () => null),
  };
  return { deps, query };
}
const as = (phone10: string, email: string | null = null) => ({ phone10, email });

beforeEach(() => { vi.restoreAllMocks(); });

describe("v858 who is signing", () => {
  it("lists the signers in SignNow order, with the applicant's CRM phone counting for Owner 1", () => {
    const s = signersOf({ applicantName: "Sean Dwyer", applicantEmail: SEAN.email, owners: [{ ...SEAN, phone: null }, ELIZ] }, ["+1 (587) 555-0141"]);
    expect(s.map((x) => [x.index, x.role, x.name, x.email, x.phones])).toEqual([
      [1, "Owner 1", "Sean Dwyer", SEAN.email, [SEAN10]],
      [2, "Owner 2", "Elizabeth Cullen", ELIZ.email, [ELIZ10]],
    ]);
  });

  it("a phone match wins; a shared inbox alone never identifies anyone", () => {
    const s = signersOf({ applicantName: "Sean Dwyer", applicantEmail: "office@pokeprod.test", owners: [SEAN, { ...ELIZ, email: "office@pokeprod.test" }] });
    expect(matchSigners(s, ELIZ10, ["office@pokeprod.test"]).map((x) => x.index)).toEqual([2]);
    expect(matchSigners(s, STRANGER10, ["office@pokeprod.test"])).toEqual([]);
    const t = signersOf({ applicantName: "Sean Dwyer", applicantEmail: SEAN.email, owners: [SEAN, { ...ELIZ, phone: null }] });
    expect(matchSigners(t, STRANGER10, [ELIZ.email.toUpperCase()]).map((x) => x.index)).toEqual([2]);
  });
});

describe("v858 GET /api/client/signing-session answers for the signed-in owner only", () => {
  it("1. Owner 1 (the applicant) gets their own link through the existing session path", async () => {
    const { deps } = setup();
    const out: any = await clientSigningSession(APP, as(SEAN10), deps);
    expect(out.kind).toBe("answer");
    expect(out.body).toMatchObject({ status: "ready", url: "https://signnow.test/link/" + SEAN.email, signer: { index: 1, role: "Owner 1", isApplicant: true } });
    expect(deps.ownerOneSession).toHaveBeenCalledWith(APP);
    expect(deps.mintLink).not.toHaveBeenCalled();
  });

  it("1. Owner 2 (Elizabeth) gets a link minted for HER email once Sean has signed - never Sean's", async () => {
    const { deps } = setup({ signed: new Set([SEAN.email]) });
    const out: any = await clientSigningSession(APP, as(ELIZ10), deps);
    expect(out.body).toMatchObject({ status: "ready", url: "https://signnow.test/link/" + ELIZ.email, signer: { index: 2, role: "Owner 2", name: "Elizabeth Cullen", isApplicant: false } });
    expect(deps.mintLink).toHaveBeenCalledTimes(1);
    expect(deps.mintLink).toHaveBeenCalledWith("grp-1", "inv-1", ELIZ.email);
    expect(deps.ownerOneSession).not.toHaveBeenCalled();
    expect(JSON.stringify(out.body)).not.toContain(SEAN.email);
  });

  it("1. Owner 3 is matched by their own phone and waits for Owner 2", async () => {
    const { deps } = setup({ owners: [SEAN, ELIZ, THIRD], signed: new Set([SEAN.email]) });
    const out: any = await clientSigningSession(APP, as(TOM10), deps);
    expect(out.body).toMatchObject({ status: "not_ready", reason: "waiting_for_signer", waitingFor: "Elizabeth Cullen", signer: { index: 3 } });
    expect(deps.mintLink).not.toHaveBeenCalled();
  });

  it("2. Elizabeth before Sean has signed: Waiting for Sean Dwyer to sign first", async () => {
    const { deps } = setup();
    const out: any = await clientSigningSession(APP, as(ELIZ10), deps);
    expect(out.body).toEqual({ status: "not_ready", reason: "waiting_for_signer", waitingFor: "Sean Dwyer", signer: { index: 2, role: "Owner 2", name: "Elizabeth Cullen", isApplicant: false } });
    expect(deps.mintLink).not.toHaveBeenCalled();
  });

  it("2. SignNow refusing the step (19019002) is also reported as waiting, not as an error", async () => {
    const { deps } = setup({ mintError: new Error("SignNow 400: 19019002 Provided email doesn't belong to any of signers of current or prev steps") });
    (deps.signerComplete as any).mockRejectedValue(new Error("status unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out: any = await clientSigningSession(APP, as(ELIZ10), deps);
    expect(out.body).toMatchObject({ status: "not_ready", reason: "waiting_for_signer", waitingFor: "Sean Dwyer" });
    expect(warn).toHaveBeenCalled();
  });

  it("2. no document yet: Owner 2 is told Sean signs first (nothing is built or minted for her)", async () => {
    const { deps } = setup({ embedded: null });
    const out: any = await clientSigningSession(APP, as(ELIZ10), deps);
    expect(out.body).toMatchObject({ status: "not_ready", reason: "documents_not_ready", waitingFor: "Sean Dwyer" });
    expect(deps.ownerOneSession).not.toHaveBeenCalled();
    expect(deps.mintLink).not.toHaveBeenCalled();
  });

  it("3. an owner who has already signed is told so", async () => {
    const { deps } = setup({ signed: new Set([SEAN.email, ELIZ.email]) });
    const out: any = await clientSigningSession(APP, as(ELIZ10), deps);
    expect(out.body).toEqual({ status: "signed", signer: { index: 2, role: "Owner 2", name: "Elizabeth Cullen", isApplicant: false } });
    expect(deps.mintLink).not.toHaveBeenCalled();
    const sean: any = await clientSigningSession(APP, as(SEAN10), deps);
    expect(sean.body).toMatchObject({ status: "signed", signer: { index: 1 } });
  });

  it("3. a fully signed application says signed for everyone", async () => {
    const { deps } = setup({ signedAt: "2026-10-25T12:00:00Z" });
    const out: any = await clientSigningSession(APP, as(ELIZ10), deps);
    expect(out.body).toMatchObject({ status: "signed", allSigned: true, signer: { index: 2 } });
    expect(deps.mintLink).not.toHaveBeenCalled();
  });

  it("4. a signed-in person who is not a signer is refused", async () => {
    const { deps } = setup({ people: [{ v858_role: "applicant", phone: SEAN10, email: SEAN.email }, { v858_role: "guarantor", phone: STRANGER10, email: "guarantor@x.test" }] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await clientSigningSession(APP, as(STRANGER10), deps)).toEqual({ kind: "refuse", status: 403, error: "not_a_signer" });
    expect(deps.ownerOneSession).not.toHaveBeenCalled();
    expect(deps.mintLink).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("4. a 10% partner below the signing threshold is on the file but is not a signer", async () => {
    const { deps } = setup({ owners: [SEAN] });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await clientSigningSession(APP, as(ELIZ10), deps)).toMatchObject({ kind: "refuse", error: "not_a_signer" });
  });

  it("4. an unknown application is a 404", async () => {
    const { deps, query } = setup();
    query.mockImplementation(answerBySql([[/AS v858_embedded/, { rows: [] }]]));
    expect(await clientSigningSession(APP, as(SEAN10), deps)).toEqual({ kind: "refuse", status: 404, error: "application_not_found" });
  });

  it("5. a document built for someone else in Owner 2's slot is never opened for her", async () => {
    const { deps } = setup({ signed: new Set([SEAN.email]), queue: [{ index: 2, email: "old-partner@pokeprod.test", name: "Old Partner" }] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out: any = await clientSigningSession(APP, as(ELIZ10), deps);
    expect(out.body).toMatchObject({ status: "not_ready", reason: "signer_details_changed" });
    expect(deps.mintLink).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("5. v857's stored signer list decides which email the document was built for", async () => {
    const embedded = { group_id: "grp-1", invite_id: "inv-1", signers: [{ index: 1, email: SEAN.email }, { index: 2, email: ELIZ.email.toUpperCase() }] };
    const { deps } = setup({ embedded, signed: new Set([SEAN.email]) });
    const out: any = await clientSigningSession(APP, as(ELIZ10), deps);
    expect(out.body.status).toBe("ready");
    expect(deps.mintLink).toHaveBeenCalledWith("grp-1", "inv-1", ELIZ.email.toUpperCase());
  });

  it("5. with v857 installed the answer carries Elizabeth's own never-expiring link", async () => {
    const { deps } = setup({ signed: new Set([SEAN.email]) });
    (deps.ownerLink as any).mockImplementation(async (app: string, index: number, email: string) => "https://server.test/api/signing/owner/" + app + "." + index + "." + email.length);
    const out: any = await clientSigningSession(APP, as(ELIZ10), deps);
    expect(deps.ownerLink).toHaveBeenCalledWith(APP, 2, ELIZ.email);
    expect(out.body.ownerLink).toBe("https://server.test/api/signing/owner/" + APP + ".2." + ELIZ.email.length);
  });

  it("5. a phone listed for two owners works through them in order and never skips ahead", async () => {
    const shared = { ...ELIZ, phone: SEAN.phone };
    const { deps } = setup({ owners: [SEAN, shared] });
    const first: any = await clientSigningSession(APP, as(SEAN10), deps);
    expect(first.body).toMatchObject({ status: "ready", signer: { index: 1 } });
    const { deps: after } = setup({ owners: [SEAN, shared], signed: new Set([SEAN.email]) });
    const second: any = await clientSigningSession(APP, as(SEAN10), after);
    expect(second.body).toMatchObject({ status: "ready", url: "https://signnow.test/link/" + ELIZ.email, signer: { index: 2 } });
  });

  it("SBA: owners after the applicant sign the envelope SignNow emails them", async () => {
    const { deps } = setup({ sba: true });
    const out: any = await clientSigningSession(APP, as(ELIZ10), deps);
    expect(out.body).toMatchObject({ status: "not_ready", reason: "signs_by_email", signer: { index: 2 } });
    expect(deps.mintLink).not.toHaveBeenCalled();
  });

  it("a SignNow failure is logged and reported as an error", async () => {
    const { deps } = setup({ signed: new Set([SEAN.email]), mintError: new Error("SignNow 500") });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out: any = await clientSigningSession(APP, as(ELIZ10), deps);
    expect(out.body).toMatchObject({ status: "error", reason: "signing_link_failed" });
    expect(err).toHaveBeenCalled();
  });
});
