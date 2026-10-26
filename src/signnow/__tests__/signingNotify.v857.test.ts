// BF_SERVER_v857_SIGNING_NOTIFY - Send for signing tells every signer who still has to sign (email always, text with
// consent) and reports each one; partners get a signing link that never expires.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, type SqlRule } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ dbQuery: vi.fn() }));
vi.mock("../../db.js", () => ({ dbQuery: h.dbQuery, pool: { query: h.dbQuery } }));

import {
  applicantSigningUrl, displaySignerName, notifySigners, ownerSigningUrl, parseOwnerSigningToken, resolveOwnerSigningLink,
  signerFingerprint, signersFromInputs, type NotifyDeps, type LinkDeps,
} from "../signingNotify.js";

const APP = "7f1e2d3c-0000-4000-8000-000000000857";
const POKE = {
  applicantEmail: "pokedwyer@gmail.com",
  applicantName: "Sean Dwyer",
  owners: [
    { firstName: "Sean", lastName: "Dwyer", email: "pokedwyer@gmail.com", phone: "+13238982498" },
    { firstName: "Elizabeth", lastName: "Cullen", email: "pokecullen@gmail.com", phone: "(310) 663-1364" },
  ],
};
const APP_ROW = /SELECT signnow_app_signed_at, metadata->'signnow_embedded' AS v857_embedded,\s+COALESCE/;
const CONSENT = /AS v857_consent/;
const RECORD = /'signing_notify'/;
const NOW = new Date("2026-10-25T22:02:00.000Z");

function deps(rules: SqlRule[], over: Partial<NotifyDeps> = {}) {
  const query = vi.fn(answerBySql(rules));
  const d: NotifyDeps & { emails: any[]; texts: any[] } = {
    emails: [], texts: [],
    query: query as any,
    loadInputs: vi.fn(async () => POKE),
    signerComplete: vi.fn(async () => false),
    sendEmail: vi.fn(async (m) => { d.emails.push(m); return { ok: true }; }),
    sendSms: vi.fn(async (m) => { d.texts.push(m); }),
    ...over,
  };
  return d;
}
const consent = (byPhone: Record<string, { consent?: boolean | null; optedOut?: boolean }>): SqlRule =>
  [CONSENT, (_s: string, p?: unknown[]) => {
    const c = byPhone[String(p?.[0])] ?? {};
    return { rows: [{ v857_consent: c.consent ?? null, v857_opted_out: c.optedOut === true }] };
  }];
const unsigned: SqlRule = [APP_ROW, { rows: [{ signnow_app_signed_at: null, v857_embedded: { group_id: "grp-2", invite_id: "inv-2" }, v857_business: "Poke Prod LLC" }] }];

beforeEach(() => {
  h.dbQuery.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("v857 who signs", () => {
  it("lists the applicant (CRM email) and every other owner in role order", () => {
    const s = signersFromInputs({ ...POKE, applicantEmail: "sean@crm.example" });
    expect(s.map((x) => [x.role, x.name, x.email])).toEqual([
      ["Owner 1", "Sean Dwyer", "sean@crm.example"],
      ["Owner 2", "Elizabeth Cullen", "pokecullen@gmail.com"],
    ]);
  });

  it("the fingerprint changes with a name, email or phone, and only then", () => {
    const base = signerFingerprint(signersFromInputs(POKE));
    expect(signerFingerprint(signersFromInputs({ ...POKE }))).toBe(base);
    expect(signerFingerprint(signersFromInputs({ ...POKE, applicantName: "Unknown (application started)" }))).not.toBe(base);
    expect(signerFingerprint(signersFromInputs({ ...POKE, applicantEmail: "other@x.com" }))).not.toBe(base);
    const phone = { ...POKE, owners: [POKE.owners[0], { ...POKE.owners[1], phone: "3105550000" }] };
    expect(signerFingerprint(signersFromInputs(phone))).not.toBe(base);
    expect(signerFingerprint(signersFromInputs({ ...POKE, applicantEmail: "POKEDWYER@gmail.com " }))).toBe(base);
  });
});

describe("v857 notifySigners", () => {
  it("emails and texts Sean (consented) with the portal signing link; emails Elizabeth her own link and says why she was not texted", async () => {
    const d = deps([unsigned, consent({ "3238982498": { consent: true } })]);
    const out = await notifySigners(APP, d, () => NOW);
    expect(out.allSigned).toBe(false);
    const [sean, liz] = out.signers;
    expect(sean).toMatchObject({ role: "Owner 1", name: "Sean Dwyer", isApplicant: true, waitingFor: null,
      email: { to: "pokedwyer@gmail.com", status: "sent", at: NOW.toISOString() },
      sms: { to: "(323) 898-2498", status: "sent", at: NOW.toISOString() } });
    expect(liz).toMatchObject({ role: "Owner 2", name: "Elizabeth Cullen", waitingFor: "Sean Dwyer",
      email: { to: "pokecullen@gmail.com", status: "sent" },
      sms: { to: "(310) 663-1364", status: "skipped" } });
    expect(liz!.sms.reason).toMatch(/Text me updates/);

    const portal = applicantSigningUrl(APP);
    expect(portal).toBe(`https://client.boreal.financial/application/${APP}?sign=1`);
    expect(d.emails[0]).toMatchObject({ to: "pokedwyer@gmail.com", subject: "Please sign your Boreal Financial application" });
    expect(d.emails[0].html).toContain(`href="${portal}"`);
    expect(d.emails[0].html).toContain("Poke Prod LLC");
    expect(d.emails[0].html).not.toMatch(/Unknown|application started/);
    expect(d.texts).toEqual([expect.objectContaining({ to: "+13238982498", kind: "owner1_signing" })]);
    expect(d.texts[0].text).toContain(portal);
    expect(d.texts[0].text).toContain("Reply STOP to opt out");

    const lizLink = ownerSigningUrl(APP, 2, "pokecullen@gmail.com")!;
    expect(lizLink).toMatch(new RegExp(`^https://server\\.boreal\\.financial/api/signing/owner/${APP}\\.2\\.[A-Za-z0-9_-]{43}$`));
    expect(d.emails[1].html).toContain(lizLink);
    expect(d.emails[1].html).toContain("Sean Dwyer signs first");

    const rec = callsMatching(d.query as any, RECORD);
    expect(rec).toHaveLength(1);
    expect(rec[0][1]![0]).toBe(APP);
    expect(JSON.parse(String(rec[0][1]![1])).signers).toHaveLength(2);
    expect(rec[0][1]![2]).toBe(true); // owner1_signing_sms_at stamped: Sean was texted
  });

  it("never texts a number that replied STOP or never said yes, and says so; the email still goes", async () => {
    const d = deps([unsigned, consent({ "3238982498": { consent: true, optedOut: true } })]);
    const out = await notifySigners(APP, d, () => NOW);
    expect(d.texts).toHaveLength(0);
    expect(out.signers[0]!.sms).toMatchObject({ status: "skipped", reason: "this number replied STOP to Boreal texts" });
    expect(out.signers[0]!.email.status).toBe("sent");
    expect(callsMatching(d.query as any, RECORD)[0][1]![2]).toBe(false);
  });

  it("reports a failed email and a failed text instead of claiming they went", async () => {
    const d = deps([unsigned, consent({ "3238982498": { consent: true }, "3106631364": { consent: true } })], {
      sendEmail: vi.fn(async () => ({ ok: false, error: "status 401" })),
      sendSms: vi.fn(async () => { throw new Error("21610 unsubscribed"); }),
    });
    const out = await notifySigners(APP, d, () => NOW);
    for (const s of out.signers) {
      expect(s.email).toMatchObject({ status: "failed", reason: "email could not be sent: status 401" });
      expect(s.sms).toMatchObject({ status: "failed", reason: "the text could not be sent: 21610 unsubscribed" });
    }
  });

  it("skips a signer who already signed, and the partner's link no longer waits for Sean", async () => {
    const d = deps([unsigned, consent({})], { signerComplete: vi.fn(async (_g: string, email: string) => email === "pokedwyer@gmail.com") });
    const out = await notifySigners(APP, d, () => NOW);
    expect(out.signers[0]).toMatchObject({ alreadySigned: true, email: { status: "skipped", reason: "already signed" } });
    expect(out.signers[1]).toMatchObject({ alreadySigned: false, waitingFor: null, email: { status: "sent" } });
    expect(d.emails).toHaveLength(1);
    expect(d.emails[0].html).toContain("Please review and sign");
  });

  it("an owner with no email cannot be on the SignNow invite: staff are told to add it", async () => {
    const noEmail = { ...POKE, owners: [POKE.owners[0], { ...POKE.owners[1], email: null }] };
    const d = deps([unsigned, consent({})], { loadInputs: vi.fn(async () => noEmail) });
    const out = await notifySigners(APP, d, () => NOW);
    expect(out.signers[1]!.email.status).toBe("skipped");
    expect(out.signers[1]!.email.reason).toMatch(/no email address on file/);
  });

  it("sends nothing once the application is signed", async () => {
    const d = deps([[APP_ROW, { rows: [{ signnow_app_signed_at: "2026-10-25T00:00:00Z", v857_embedded: {}, v857_business: "Poke Prod LLC" }] }]]);
    const out = await notifySigners(APP, d, () => NOW);
    expect(out).toMatchObject({ allSigned: true, signers: [] });
    expect(d.emails).toHaveLength(0);
    expect(d.texts).toHaveLength(0);
  });

  it("a failed record is logged and the result still returned", async () => {
    const d = deps([unsigned, consent({}), [RECORD, new Error("db down")]]);
    const out = await notifySigners(APP, d, () => NOW);
    expect(out.signers).toHaveLength(2);
    expect(console.error).toHaveBeenCalledWith("[signing-notify] record failed", expect.objectContaining({ applicationId: APP }));
  });
});

describe("v857 the partner's own signing link", () => {
  const STORED = [
    { index: 1, role: "Owner 1", name: "Sean Dwyer", email: "pokedwyer@gmail.com" },
    { index: 2, role: "Owner 2", name: "Elizabeth Cullen", email: "pokecullen@gmail.com" },
  ];
  const token = () => ownerSigningUrl(APP, 2, "pokecullen@gmail.com")!.split("/api/signing/owner/")[1]!;
  function linkDeps(row: Record<string, unknown> | null, over: Partial<LinkDeps> = {}): LinkDeps {
    return {
      query: vi.fn(answerBySql([[/AS v857_embedded FROM applications/, { rows: row ? [row] : [] }]])) as any,
      loadInputs: vi.fn(async () => POKE),
      signerComplete: vi.fn(async () => false),
      mintLink: vi.fn(async (_g: string, _i: string, email: string) => ({ url: "https://app.signnow.com/x/" + email })),
      ...over,
    };
  }
  const live = { signnow_app_signed_at: null, v857_embedded: { group_id: "grp-2", invite_id: "inv-2", signers: STORED } };

  it("parses only well-formed tokens", () => {
    expect(parseOwnerSigningToken(token())).toMatchObject({ applicationId: APP, index: 2 });
    expect(parseOwnerSigningToken("nope")).toBeNull();
    expect(parseOwnerSigningToken(`${APP}.1.${"a".repeat(43)}`)).toBeNull();
  });

  it("opens a fresh SignNow link for that owner", async () => {
    const d = linkDeps(live);
    expect(await resolveOwnerSigningLink(token(), d)).toEqual({ kind: "redirect", url: "https://app.signnow.com/x/pokecullen@gmail.com" });
    expect(d.mintLink).toHaveBeenCalledWith("grp-2", "inv-2", "pokecullen@gmail.com");
  });

  it("before Sean has signed it says he signs first", async () => {
    const d = linkDeps(live, { mintLink: vi.fn(async () => { throw new Error("SignNow POST failed: 400 {\"code\":19019002}"); }) });
    const out = await resolveOwnerSigningLink(token(), d);
    expect(out.kind).toBe("page");
    expect(out.kind === "page" && out.html).toContain("Sean Dwyer signs first");
  });

  it("refuses a tampered token, or one for an owner whose email has changed", async () => {
    const bad = token().slice(0, -2) + (token().endsWith("AA") ? "BB" : "AA");
    expect(await resolveOwnerSigningLink(bad, linkDeps(live))).toMatchObject({ kind: "page", status: 404 });
    const moved = { ...live, v857_embedded: { ...live.v857_embedded, signers: [STORED[0], { ...STORED[1], email: "new@x.com" }] } };
    expect(await resolveOwnerSigningLink(token(), linkDeps(moved))).toMatchObject({ kind: "page", status: 404 });
  });

  it("says so when everything is signed, or when this owner already signed", async () => {
    const all = await resolveOwnerSigningLink(token(), linkDeps({ ...live, signnow_app_signed_at: "2026-10-25" }));
    expect(all.kind === "page" && all.html).toContain("All signatures are in");
    const mine = await resolveOwnerSigningLink(token(), linkDeps(live, { signerComplete: vi.fn(async () => true) }));
    expect(mine.kind === "page" && mine.html).toContain("You have already signed");
  });
});

describe("v857 historical records signed under the placeholder", () => {
  it("shows the applicant's real name; a real stored name is left alone", async () => {
    h.dbQuery.mockImplementation(answerBySql([[/AS v851_applicant/, { rows: [{ v851_applicant: { firstName: "Sean", lastName: "Dwyer" } }] }]]));
    expect(await displaySignerName(APP, "Unknown (application started)")).toBe("Sean Dwyer");
    expect(await displaySignerName(APP, "Elizabeth Cullen")).toBe("Elizabeth Cullen");
  });
});
