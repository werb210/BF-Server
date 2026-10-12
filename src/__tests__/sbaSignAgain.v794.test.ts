// BF_SERVER_SBA_SIGN_AGAIN_v794
import { createHash } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  queryMock: vi.fn(),
  isSba: true,
  snapshot: { allDocsAccepted: true, allTasksComplete: true, lenderSelectionsFinalized: true, applicationSigned: true, collateralRequired: false, collateralComplete: false },
  startSbaSigningForStaff: vi.fn(async () => ({ started: true, owners: [{ ownerIndex: 1, name: "Jane", email: "j@x.com", started: true, delivery: "client portal" }] })),
  getOrCreateEmbeddedSigningSession: vi.fn(async () => ({ status: "signed" })),
  put: vi.fn(async () => ({ blobName: "sba/new.pdf", url: "https://blob/new.pdf", sizeBytes: 9 })),
  signedBytes: Buffer.from("signed-pdf-v2"),
}));

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return {
    ...actual,
    pool: { query: h.queryMock, connect: vi.fn(async () => ({ query: h.queryMock, release: vi.fn() })) },
    runQuery: h.queryMock, dbQuery: h.queryMock, query: h.queryMock,
  };
});
vi.mock("../services/submission/orchestrator.js", () => ({ readReadinessSnapshot: vi.fn(async () => ({ ...h.snapshot })) }));
vi.mock("../signnow/sba/sbaTrigger.js", () => ({
  isSbaApplication: vi.fn(async () => h.isSba),
  sbaEnvelopeCount: vi.fn(async () => 0),
  sbaFormsComplete: vi.fn(async () => ({ complete: true, missing: [] })),
  startSbaSigningForStaff: h.startSbaSigningForStaff,
}));
vi.mock("../signnow/embeddedSigningSession.js", () => ({ getOrCreateEmbeddedSigningSession: h.getOrCreateEmbeddedSigningSession }));
vi.mock("../signnow/signnowClient.js", () => ({
  isApiKeyConfigured: () => true,
  uploadDocumentWithFieldExtract: vi.fn(), createDocumentGroup: vi.fn(), createEmbeddedGroupInvite: vi.fn(),
  createEmbeddedGroupLink: vi.fn(), sendGroupEmailInvite: vi.fn(),
  getDocumentGroupStatus: vi.fn(async () => ({ signed: true })),
  downloadDocument: vi.fn(async () => h.signedBytes),
}));
vi.mock("../signnow/sba/sbaSignDate.js", () => ({
  sbaSignDateFor: vi.fn(async () => null),
  stampSbaSignDate: vi.fn(async (_name: string, buf: Buffer) => buf),
}));
vi.mock("../lib/storage/index.js", () => ({ getStorage: () => ({ put: h.put }) }));

const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const token = () => jwt.sign({ sub: "00000000-0000-4000-8000-0000000000b1", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

async function buildApp() {
  const router = (await import("../modules/applications/applications.routes.js")).default;
  const { errorHandler } = await import("../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use("/api/applications", router);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([[/SELECT silo FROM applications/, { rows: [{ silo: "BF" }] }]]));
  h.isSba = true;
  h.snapshot = { allDocsAccepted: true, allTasksComplete: true, lenderSelectionsFinalized: true, applicationSigned: true, collateralRequired: false, collateralComplete: false };
  h.startSbaSigningForStaff.mockClear();
  h.getOrCreateEmbeddedSigningSession.mockClear();
  h.put.mockClear();
});

describe("signing an SBA file again", () => {
  const resend = async (body: Record<string, unknown>) =>
    request(await buildApp()).post(`/api/applications/${APP_ID}/resend-signing`).set("Authorization", `Bearer ${token()}`).send(body);

  it("resend-signing with again: true ignores the signed stamp on an SBA file", async () => {
    const res = await resend({ again: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: true, reason: "ready" });
    expect(h.startSbaSigningForStaff).toHaveBeenCalledWith(APP_ID);
  });

  it("without again, a signed SBA file is reported as signed", async () => {
    const res = await resend({});
    expect(res.body.data).toMatchObject({ ok: false, reason: "signed" });
    expect(h.startSbaSigningForStaff).not.toHaveBeenCalled();
  });

  it("again: true does not unlock a signed non-SBA file", async () => {
    h.isSba = false;
    const res = await resend({ again: true });
    expect(res.body.data).toMatchObject({ ok: false, reason: "signed" });
    expect(h.startSbaSigningForStaff).not.toHaveBeenCalled();
    expect(h.getOrCreateEmbeddedSigningSession).not.toHaveBeenCalled();
  });

  it("readiness tells the portal it is an SBA file", async () => {
    const app = await buildApp();
    const sba = await request(app).get(`/api/applications/${APP_ID}/signing-readiness`).set("Authorization", `Bearer ${token()}`);
    expect(sba.body.data.isSba).toBe(true);
    h.isSba = false;
    const other = await request(app).get(`/api/applications/${APP_ID}/signing-readiness`).set("Authorization", `Bearer ${token()}`);
    expect(other.body.data.isSba).toBe(false);
  });

  describe("a re-signed form replaces the old copy under Documents instead of being skipped", () => {
    const envelope = { ownerIndex: 1, email: "j@x.com", groupId: "grp-1", inviteId: "inv-1", docIds: ["sn-doc-2"], docNames: ["sba-413-owner1.pdf"] };
    const answers = (storedHash: string) => answerBySql([
      [/SELECT metadata FROM applications/, { rows: [{ metadata: { sba_signnow: [envelope] } }] }],
      [/SELECT id FROM documents WHERE application_id/, { rows: [{ id: "doc-1" }] }],
      [/FROM document_versions WHERE document_id = \$1 AND metadata->>'signnow_doc_id'/, { rows: [{ n: "0" }] }],
      [/SELECT hash FROM documents WHERE id = \$1/, { rows: [{ hash: storedHash }] }],
    ]);

    it("new signed bytes update the existing document and add a version", async () => {
      h.queryMock.mockImplementation(answers("old-hash"));
      const { attachSignedSbaDocuments } = await import("../signnow/sba/sbaSigning.js");
      expect(await attachSignedSbaDocuments(APP_ID)).toEqual({ attached: 1 });
      const newHash = createHash("sha256").update(h.signedBytes).digest("hex");
      const [, params] = callsMatching(h.queryMock, /UPDATE documents SET hash = \$2/)[0]!;
      expect(params).toEqual(["doc-1", newHash, "sba/new.pdf", "https://blob/new.pdf", 9]);
      expect(callsMatching(h.queryMock, /INSERT INTO document_versions/)).toHaveLength(1);
      expect(callsMatching(h.queryMock, /INSERT INTO documents/)).toHaveLength(0);
    });

    it("identical bytes are left alone", async () => {
      h.queryMock.mockImplementation(answers(createHash("sha256").update(h.signedBytes).digest("hex")));
      const { attachSignedSbaDocuments } = await import("../signnow/sba/sbaSigning.js");
      expect(await attachSignedSbaDocuments(APP_ID)).toEqual({ attached: 0 });
      expect(callsMatching(h.queryMock, /UPDATE documents SET hash/)).toHaveLength(0);
      expect(h.put).not.toHaveBeenCalled();
    });
  });
});
