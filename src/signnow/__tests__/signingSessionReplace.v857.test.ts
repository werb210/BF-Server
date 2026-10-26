// BF_SERVER_v857_SIGNING_NOTIFY - a cached signing document built for other signer details (the Poke Prod case: built
// while the applicant was "Unknown (application started)") is replaced, never re-used; a matching one is re-used.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  dbQuery: vi.fn(), group: vi.fn(), invite: vi.fn(), link: vi.fn(), complete: vi.fn(), cancel: vi.fn(), notify: vi.fn(),
}));
vi.mock("../../db.js", () => ({ dbQuery: h.dbQuery, pool: { query: h.dbQuery } }));
vi.mock("../signnowClient.js", () => ({
  isApiKeyConfigured: () => true,
  uploadDocumentWithFieldExtract: vi.fn(async () => ({ documentId: "doc-new" })),
  createDocumentGroup: h.group,
  createEmbeddedGroupInvite: h.invite,
  createEmbeddedGroupLink: h.link,
  getSignerInviteComplete: h.complete,
  cancelEmbeddedGroupInvites: h.cancel,
}));
vi.mock("../sendApplicationForSignature.js", () => ({
  loadApplicationForPdf: vi.fn(async () => ({
    applicationId: "app-857", business: { legalName: "Poke Prod LLC" }, applicantEmail: "pokedwyer@gmail.com", applicantName: "Sean Dwyer",
    owners: [
      { firstName: "Sean", lastName: "Dwyer", email: "pokedwyer@gmail.com", phone: "+13238982498" },
      { firstName: "Elizabeth", lastName: "Cullen", email: "pokecullen@gmail.com", phone: "3106631364" },
    ],
  })),
}));
vi.mock("../pdfBuilder.js", () => ({ buildApplicationPdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])) }));
vi.mock("../accordPdfBuilder.js", () => ({ buildAccordPdf: vi.fn() }));
vi.mock("../blobStorage.js", () => ({ uploadSignedApplicationPdf: vi.fn(async () => ({ blobName: "b", url: "u" })) }));
vi.mock("../pnwSigning.js", () => ({ pnwSigningSatisfiedForAppSigning: vi.fn(async () => true) }));
vi.mock("../sba/sbaTrigger.js", () => ({ isSbaApplication: vi.fn(async () => false) }));
vi.mock("../../services/notifications/notifyClient.js", () => ({ notifyClient: h.notify }));

import { getOrCreateEmbeddedSigningSession } from "../embeddedSigningSession.js";
import { signerFingerprint, signersFromInputs } from "../signingNotify.js";

const APP = "app-857";
const CURRENT_FP = signerFingerprint(signersFromInputs({
  applicantEmail: "pokedwyer@gmail.com", applicantName: "Sean Dwyer",
  owners: [
    { firstName: "Sean", lastName: "Dwyer", email: "pokedwyer@gmail.com", phone: "+13238982498" },
    { firstName: "Elizabeth", lastName: "Cullen", email: "pokecullen@gmail.com", phone: "3106631364" },
  ],
}));
const SAVE = /SET signnow_document_id = \$2/;

function appWith(embedded: Record<string, unknown> | null) {
  h.dbQuery.mockImplementation(answerBySql([
    [/SELECT a\.signnow_app_signed_at, a\.metadata/, { rows: [{ signnow_app_signed_at: null, metadata: embedded ? { signnow_embedded: embedded } : {}, finalized_count: "1" }] }],
  ], { rows: [], rowCount: 1 }));
}

beforeEach(() => {
  for (const f of [h.dbQuery, h.group, h.invite, h.link, h.complete, h.cancel, h.notify]) f.mockReset();
  h.group.mockResolvedValue({ groupId: "grp-new" });
  h.invite.mockResolvedValue({ inviteId: "inv-new" });
  h.link.mockImplementation(async (g: string) => ({ url: "https://sign.test/" + g, expiresAt: null }));
  h.complete.mockResolvedValue(false);
  h.cancel.mockResolvedValue(undefined);
  h.notify.mockResolvedValue({ channel: "sms" });
  delete process.env.SIGNNOW_STUB_MODE;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("v857 signing session replacement", () => {
  it("replaces the Oct 23 document (built before v857, under the placeholder name) instead of re-using it", async () => {
    appWith({ group_id: "grp-old", invite_id: "inv-old", doc_ids: ["doc-old"] });
    const r = await getOrCreateEmbeddedSigningSession(APP, { skipOwner1Notice: true });
    expect(r).toMatchObject({ status: "ready", url: "https://sign.test/grp-new", replaced: true });
    expect(h.cancel).toHaveBeenCalledWith("grp-old");
    expect(h.group).toHaveBeenCalledTimes(1);
    expect(h.invite.mock.calls[0]![2]).toEqual([
      { email: "pokedwyer@gmail.com", name: "Sean Dwyer", roleName: "Owner 1" },
      { email: "pokecullen@gmail.com", name: "Elizabeth Cullen", roleName: "Owner 2" },
    ]);
    const save = callsMatching(h.dbQuery, SAVE)[0]![1] as unknown[];
    expect(save[7]).toBe(CURRENT_FP);
    expect(JSON.parse(String(save[8]))).toEqual([
      { index: 1, role: "Owner 1", name: "Sean Dwyer", email: "pokedwyer@gmail.com" },
      { index: 2, role: "Owner 2", name: "Elizabeth Cullen", email: "pokecullen@gmail.com" },
    ]);
    // staff pressed the button: the session sends no text of its own (notifySigners does), and a replacement never does
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("replaces a document whose signer details changed", async () => {
    appWith({ group_id: "grp-old", invite_id: "inv-old", doc_ids: ["doc-old"], signers_fp: "v857:something-else" });
    const r = await getOrCreateEmbeddedSigningSession(APP);
    expect(r).toMatchObject({ status: "ready", replaced: true });
    expect(h.notify).not.toHaveBeenCalled(); // the client portal re-built it: not a new request
  });

  it("re-uses a document built for the same signers", async () => {
    appWith({ group_id: "grp-same", invite_id: "inv-same", doc_ids: ["doc-same"], signers_fp: CURRENT_FP });
    const r = await getOrCreateEmbeddedSigningSession(APP);
    expect(r).toEqual({ status: "ready", url: "https://sign.test/grp-same", expiresAt: null });
    expect(h.group).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("keeps a document Owner 1 already signed, even if details changed since", async () => {
    appWith({ group_id: "grp-old", invite_id: "inv-old", doc_ids: ["doc-old"] });
    h.complete.mockResolvedValue(true);
    expect(await getOrCreateEmbeddedSigningSession(APP)).toEqual({ status: "signed" });
    expect(h.group).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("a cancel failure is logged and the fresh document is still built", async () => {
    appWith({ group_id: "grp-old", invite_id: "inv-old", doc_ids: ["doc-old"] });
    h.cancel.mockRejectedValue(new Error("404"));
    const r = await getOrCreateEmbeddedSigningSession(APP, { skipOwner1Notice: true });
    expect(r).toMatchObject({ status: "ready", replaced: true });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("could not cancel the old signing invite"));
  });

  it("a first session built without staff still texts Owner 1 as before", async () => {
    appWith(null);
    const r = await getOrCreateEmbeddedSigningSession(APP);
    expect(r).toMatchObject({ status: "ready" });
    expect(r).not.toHaveProperty("replaced");
    expect(h.notify).toHaveBeenCalledTimes(1);
  });
});
