// BF_SERVER_v789_PUBLIC_UPLOAD_AUTH + BF_SERVER_v789_CLIENT_UPLOAD_CATEGORIES
// /api/documents/public-upload accepted a file for any application id with no
// credential, never saw the fraud lock (it ran before multer parsed the form)
// and stored any category, including signed_term_sheet.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-min-10-chars";

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_APP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER_PHONE = "+15875550123";
const CONT_TOKEN = "cont-token-abc";

const state = vi.hoisted(() => ({ stage: "Received" as string, inserted: 0, ip: 1 }));

function answer(sql: string, params: unknown[] = []) {
  if (sql.includes("FROM application_continuations")) {
    const ok = params[0] === "cont-token-abc" && String(params[1]).toLowerCase() === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    return { rows: ok ? [{ ok: 1 }] : [], rowCount: ok ? 1 : 0 };
  }
  if (sql.includes("WITH app_phones AS")) {
    if (params[0] !== "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") return { rows: [{ total: 0, mine: 0, known: 0 }] };
    return { rows: [{ total: 1, mine: params[1] === "5875550123" ? 1 : 0, known: 1 }] };
  }
  if (sql.includes("SELECT pipeline_state FROM applications")) {
    return { rows: params[0] === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" ? [{ pipeline_state: state.stage }] : [] };
  }
  if (sql.includes("INSERT INTO documents")) state.inserted += 1;
  return { rows: [], rowCount: 0 };
}

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = async (sql: string, params?: unknown[]) => answer(String(sql), params ?? []);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../lib/storage/index.js", () => ({
  getStorage: () => ({ put: async () => ({ hash: "h", blobName: "b", url: "u", sizeBytes: 4 }) }),
}));
vi.mock("../modules/ocr/ocr.service.js", () => ({ enqueueOcrForDocument: async () => undefined }));
vi.mock("../services/biDocMirror.js", () => ({ mirrorDocToBiAsync: () => undefined, withdrawDocFromBiAsync: () => undefined }));
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: async () => undefined }));
vi.mock("../routes/clientDocumentsNeeded.js", () => ({ computeOutstandingDocs: async () => ({ required: [], stillNeeded: [], rejected: [] }) }));
vi.mock("../services/documents/duplicateDocuments.js", () => ({
  assertNotDuplicate: async () => undefined,
  duplicateGroupsForApplication: async () => [],
  duplicateResponseBody: () => ({}),
  DuplicateDocumentError: class extends Error {},
}));

const sign = (claims: Record<string, unknown>) => jwt.sign(claims, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const client = (phone = OWNER_PHONE) => "Bearer " + sign({ sub: "client:" + phone, role: "client", phone, isClient: true });
const service = () => "Bearer " + sign({ kind: "service", service: "agent", principal: "service", id: "agent-service", role: "Staff" });

async function app() {
  const { default: router } = await import("../routes/documents.js");
  const a = express();
  a.use(express.json());
  a.use("/api/documents", router);
  return a;
}

// A fresh client IP per request keeps the 20/hour limiter out of the way
// except in the test that is about it.
const nextIp = () => `10.0.${Math.floor(state.ip / 250)}.${(state.ip++ % 250) + 1}`;

function upload(a: express.Express, fields: Record<string, string>, headers: Record<string, string> = {}, path = "/api/documents/public-upload") {
  let r = request(a).post(path).set("X-Forwarded-For", headers["X-Forwarded-For"] ?? nextIp());
  for (const [k, v] of Object.entries(headers)) if (k !== "X-Forwarded-For") r = r.set(k, v);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r.attach("file", Buffer.from("%PDF"), { filename: "s.pdf", contentType: "application/pdf" });
}

beforeEach(() => {
  state.stage = "Received";
  state.inserted = 0;
});

describe("public-upload requires a credential for the application", () => {
  it("no credential -> 401, nothing stored", async () => {
    const r = await upload(await app(), { applicationId: APP_ID, category: "bank_statements" });
    expect(r.status).toBe(401);
    expect(state.inserted).toBe(0);
  });

  it("the application's continuation token is accepted (header or body)", async () => {
    const a = await app();
    expect((await upload(a, { applicationId: APP_ID, category: "bank_statements" }, { "X-Continuation-Token": CONT_TOKEN })).status).toBe(200);
    expect((await upload(a, { applicationId: APP_ID, category: "bank_statements", continuationToken: CONT_TOKEN })).status).toBe(200);
    expect(state.inserted).toBe(2);
  });

  it("a continuation token for another application is refused", async () => {
    const r = await upload(await app(), { applicationId: OTHER_APP, category: "bank_statements" }, { "X-Continuation-Token": CONT_TOKEN });
    expect(r.status).toBe(401);
    expect(state.inserted).toBe(0);
  });

  it("the owning client's token is accepted, another client's is 403", async () => {
    const a = await app();
    expect((await upload(a, { applicationId: APP_ID, category: "bank_statements" }, { Authorization: client() })).status).toBe(200);
    expect((await upload(a, { applicationId: APP_ID, category: "bank_statements" }, { Authorization: client("+15875550199") })).status).toBe(403);
    expect(state.inserted).toBe(1);
  });
});

describe("public-upload fraud lock sees the multipart application id", () => {
  it("a fraud-locked application -> 423", async () => {
    state.stage = "Fraud";
    const r = await upload(await app(), { applicationId: APP_ID, category: "bank_statements" }, { "X-Continuation-Token": CONT_TOKEN });
    expect(r.status).toBe(423);
    expect(r.body.error).toBe("application_locked");
    expect(state.inserted).toBe(0);
  });
});

describe("public-upload category allow-list", () => {
  it.each(["signed_term_sheet", "Signed Term Sheet", "signed_application", "Signed Application", "media_fee_agreement", "Fee Agreement", "SBA Forms", "lender_package", "anything_else"])(
    "%s -> 400", async (category) => {
      const r = await upload(await app(), { applicationId: APP_ID, category }, { "X-Continuation-Token": CONT_TOKEN });
      expect(r.status).toBe(400);
      expect(state.inserted).toBe(0);
    },
  );

  it.each(["6 months business banking statements", "Bank Statements", "PnL \u2013 Interim financials", "A/R", "void_cheque", "Other", "sba_form_413"])(
    "%s -> accepted", async (category) => {
      const r = await upload(await app(), { applicationId: APP_ID, category }, { "X-Continuation-Token": CONT_TOKEN });
      expect(r.status).toBe(200);
    },
  );
});

describe("/upload applies the same lock and allow-list to a client", () => {
  it("client token, signed_term_sheet -> 400", async () => {
    const r = await upload(await app(), { applicationId: APP_ID, category: "signed_term_sheet" }, { Authorization: client() }, "/api/documents/upload");
    expect(r.status).toBe(400);
  });
  it("client token, fraud-locked application -> 423", async () => {
    state.stage = "Fraud";
    const r = await upload(await app(), { applicationId: APP_ID, category: "bank_statements" }, { Authorization: client() }, "/api/documents/upload");
    expect(r.status).toBe(423);
  });
  it("a service principal may still file a staff category", async () => {
    const r = await upload(await app(), { applicationId: APP_ID, category: "signed_term_sheet" }, { Authorization: service() }, "/api/documents/upload");
    expect(r.status).toBe(200);
  });
});

describe("public-upload rate limit", () => {
  it("20 an hour per IP, the 21st is 429", async () => {
    const a = await app();
    const ip = "192.0.2.77";
    for (let i = 0; i < 20; i += 1) {
      const r = await upload(a, { applicationId: APP_ID, category: "bank_statements" }, { "X-Forwarded-For": ip, "X-Continuation-Token": CONT_TOKEN });
      expect(r.status).toBe(200);
    }
    const r = await upload(a, { applicationId: APP_ID, category: "bank_statements" }, { "X-Forwarded-For": ip, "X-Continuation-Token": CONT_TOKEN });
    expect(r.status).toBe(429);
  });
});

describe("isClientUploadableCategory", () => {
  it("rejects staff-only and unknown, accepts requirement labels", async () => {
    const { isClientUploadableCategory } = await import("../services/documents/clientUploadCategories.js");
    expect(isClientUploadableCategory("signed_term_sheet")).toBe(false);
    expect(isClientUploadableCategory("")).toBe(false);
    expect(isClientUploadableCategory("x".repeat(200))).toBe(false);
    expect(isClientUploadableCategory("3 years accountant prepared financials")).toBe(true);
    expect(isClientUploadableCategory("lease_or_loi")).toBe(true);
  });

  it("every lender-product requirement label is client-uploadable (drift guard)", async () => {
    const { isClientUploadableCategory } = await import("../services/documents/clientUploadCategories.js");
    const { PORTAL_FORM_DOC_LABELS } = await import("../routes/portalLenderProducts.js");
    const labels = [...PORTAL_FORM_DOC_LABELS];
    expect(labels.length).toBeGreaterThan(20);
    for (const label of labels) expect(isClientUploadableCategory(label), label).toBe(true);
  });
});
