// BF_SERVER_EXPRESS_CONSENT_v1
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { APP_ID, PARAM_GUARD_RULE, buildV1App, submitBaseRules } from "./helpers/v1AppsHarness.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", () => ({
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));
vi.mock("../services/applicationCrmMirror.js", () => ({ mirrorApplicationToCrm: vi.fn(async () => undefined) }));
vi.mock("../services/draftProgress.js", () => ({ furthestStep: () => 0, fillDraftContact: vi.fn(async () => undefined) }));
vi.mock("../services/companies.js", () => ({ findOrCreateCompanyByNameAndSilo: vi.fn(async () => ({ row: { id: "co-1" } })) }));
vi.mock("../services/contacts.js", () => ({
  findOrCreateContactByEmailAndCompany: vi.fn(async (_tx: unknown, email: string) => ({ row: { id: email.startsWith("p") ? "ct-partner" : "ct-applicant" } })),
  createContact: vi.fn(async () => ({ id: "ct-created" })),
}));
vi.mock("../services/applicationContacts.js", () => ({ linkContactToApplication: vi.fn(async () => undefined) }));

const migration = readFileSync(path.join(process.cwd(), "migrations/2026_07_14_sms_consent.sql"), "utf8");
const STAMP = /UPDATE contacts\s+SET sms_consent\s+= true/;

async function patchSignature(body: Record<string, unknown>) {
  queryMock.mockImplementation(
    answerBySql([PARAM_GUARD_RULE, [/select id, name, pipeline_state/, { rows: [{ id: APP_ID, name: "Acme", metadata: {} }] }]]),
  );
  const res = await request(await buildV1App()).patch(`/api/client/applications/${APP_ID}`).send(body);
  expect(res.status).toBe(200);
  const update = callsMatching(queryMock, /update applications\s+set name = \$2/);
  expect(update).toHaveLength(1);
  return ((update[0]![1] as unknown[])[3] as Record<string, any>).signature;
}

async function submitNormalized(body: Record<string, unknown>) {
  queryMock.mockImplementation(answerBySql(submitBaseRules()));
  const res = await request(await buildV1App())
    .post(`/api/client/applications/${APP_ID}/submit`)
    .send({
      normalized: {
        company: { name: "Acme" },
        applicant: { first_name: "Ann", last_name: "Lee", email: "ann@acme.test" },
        partner: { first_name: "Pat", last_name: "Lee", email: "pat@acme.test" },
      },
      ...body,
    });
  expect(res.status).toBe(200);
  return callsMatching(queryMock, STAMP);
}

describe("Step 6 Communication Consent reaches the contact record", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
  });

  it("accepts all three consents, not just termsAccepted", async () => {
    const signature = await patchSignature({ termsAccepted: true, shareAuthorization: true, communicationConsent: true });
    expect(signature).toMatchObject({ termsAccepted: true, shareAuthorization: true, communicationConsent: true });
  });

  it("tolerates every shape the client may send it in", async () => {
    expect(await patchSignature({ termsAccepted: true, share_authorization: true, communication_consent: true })).toMatchObject({
      shareAuthorization: true,
      communicationConsent: true,
    });
    queryMock.mockReset();
    expect(await patchSignature({ termsAccepted: true, infoConfirmed: true })).toMatchObject({ communicationConsent: true });
  });

  it("stamps EXPRESS consent on the applicant and partner -- express does not expire", async () => {
    const stamps = await submitNormalized({ app: { signature: { communicationConsent: true } } });
    expect(stamps.map((c) => c[1])).toEqual([["ct-applicant"], ["ct-partner"]]);
    const sql = String(stamps[0]![0]);
    expect(sql).toContain("consent_basis  = 'express'");
    expect(sql).toContain("consent_source = 'application_step6'");
    expect(sql).toContain("consent_at     = now()");
  });

  it("reads the consent from the request body shapes too", async () => {
    expect(await submitNormalized({ communication_consent: true })).toHaveLength(2);
    queryMock.mockReset();
    expect(await submitNormalized({ infoConfirmed: true })).toHaveLength(2);
  });

  it("only stamps it when the box was actually ticked", async () => {
    expect(await submitNormalized({ app: { signature: { communicationConsent: false } } })).toHaveLength(0);
    queryMock.mockReset();
    expect(await submitNormalized({ communication_consent: "true" })).toHaveLength(0);
    queryMock.mockReset();
    expect(await submitNormalized({})).toHaveLength(0);
  });

  it("backfills express consent from application metadata where it exists", () => {
    expect(migration).toContain("BF_SERVER_EXPRESS_CONSENT_v1");
    expect(migration).toContain("signature,communicationConsent");
    expect(migration).toContain("'express'");
  });
});
