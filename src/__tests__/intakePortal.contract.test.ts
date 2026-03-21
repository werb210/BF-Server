import { describe, it, expect } from 'vitest';
import path from "path";
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { ensureAuditEventSchema } from "./helpers/auditSchema";

const app = buildAppWithApiRoutes();

const requestId = "intake-contract";
let idemCounter = 0;
const nextIdem = (): string => `intake-idem-${idemCounter++}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from document_version_reviews");
  await pool.query("delete from document_versions");
  await pool.query("delete from documents");
  await pool.query("delete from applications");
  await pool.query("delete from idempotency_keys");
}

beforeAll(async () => {
  process.env.JWT_SECRET = "test-access-secret";
  process.env.NODE_ENV = "test";
  await ensureAuditEventSchema();
});

beforeEach(async () => {
  await resetDb();
  idemCounter = 0;
});

afterAll(async () => {
  await pool.end();
});

describe("public intake + portal contracts", () => {
  const payload = {
    source: "api",
    country: "US",
    productCategory: "standard",
    business: { legalName: "Intake Contract LLC" },
    applicant: { firstName: "Ava", lastName: "Applicant", email: "ava@applicant.test" },
    financialProfile: { revenue: 120000 },
    match: { lenderA: 0.8 },
  };

  it("accepts intake payload and returns JSON", async () => {
    const res = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", nextIdem())
      .set("x-request-id", requestId)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.applicationId).toBeDefined();
    expect(res.body.createdAt).toBeDefined();
    expect(res.body.pipelineState).toBeDefined();
    expect(res.body.match).toEqual(payload.match);
    expect(res.text).not.toMatch(/<!doctype|<html/i);
  });

  it("returns the same response for an idempotency retry", async () => {
    const key = nextIdem();
    const first = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", key)
      .set("x-request-id", requestId)
      .send(payload);
    const second = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", key)
      .set("x-request-id", requestId)
      .send(payload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
  });

  it("returns JSON validation errors with details", async () => {
    const res = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", nextIdem())
      .set("x-request-id", "missing-fields")
      .send({});

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.code).toBe("validation_error");
    expect(Array.isArray(res.body.details?.fields)).toBe(true);
    expect(res.text).not.toMatch(/<!doctype|<html/i);
  });

  it("lists portal applications and includes uploaded documents", async () => {
    const appRes = await request(app)
      .post("/api/applications")
      .set("Idempotency-Key", nextIdem())
      .set("x-request-id", requestId)
      .send(payload);
    const applicationId = appRes.body.applicationId as string;

    const list = await request(app)
      .get("/api/portal/applications")
      .set("x-request-id", requestId);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.items)).toBe(true);
    expect(list.body.items.find((item: { id: string }) => item.id === applicationId)).toBeDefined();

    const fixturePath = path.join(__dirname, "fixtures", "sample.pdf");
    const uploadRes = await request(app)
      .post("/api/documents")
      .set("Idempotency-Key", nextIdem())
      .set("x-request-id", "upload-doc")
      .field("applicationId", applicationId)
      .field("category", "bank_statement")
      .attach("file", fixturePath);

    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.documentId).toBeDefined();

    const detail = await request(app)
      .get(`/api/portal/applications/${applicationId}`)
      .set("x-request-id", requestId);
    expect(detail.status).toBe(200);
    expect(detail.body.pipeline?.state).toBeDefined();
    expect(Array.isArray(detail.body.documents)).toBe(true);
    expect(detail.body.documents.length).toBeGreaterThan(0);
  });
});
