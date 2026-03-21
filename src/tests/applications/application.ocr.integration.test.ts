import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../../app";
import { pool } from "../../db";
import { createUserAccount } from "../../modules/auth/auth.service";
import { ROLES } from "../../auth/roles";
import {
  createApplication,
  createDocument,
  createDocumentVersion,
} from "../../modules/applications/applications.repo";
import { insertDocumentOcrFields } from "../../modules/ocr/ocr.repo";
import { otpVerifyRequest } from "../../__tests__/helpers/otpAuth";
import { ensureOcrTestSchema, resetOcrTestSchema } from "../ocr/ocrTestSchema";

const app = buildAppWithApiRoutes();
const requestId = "application-ocr-insights";
let phoneCounter = 8800;

const nextPhone = (): string => `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function loginAdmin(): Promise<string> {
  const phone = nextPhone();
  await createUserAccount({
    email: `ocr-admin-${phone}@example.com`,
    phoneNumber: phone,
    role: ROLES.ADMIN,
  });
  const login = await otpVerifyRequest(app, {
    phone,
    requestId,
    idempotencyKey: `idem-ocr-${phone}`,
  });
  return login.body.accessToken as string;
}

describe("application OCR insights integration", () => {
  beforeAll(async () => {
    process.env.JWT_SECRET = "test-access-secret";
    process.env.NODE_ENV = "test";
    await ensureOcrTestSchema();
  });

  beforeEach(async () => {
    await resetOcrTestSchema();
    await pool.query("delete from otp_verifications");
    await pool.query("delete from auth_refresh_tokens");
    await pool.query("delete from idempotency_keys");
    await pool.query("delete from users");
    phoneCounter = 8800;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("returns OCR insights in the application API response", async () => {
    const token = await loginAdmin();

    const application = await createApplication({
      ownerUserId: null,
      name: "OCR Pipeline",
      metadata: null,
      productType: "standard",
    });

    const document = await createDocument({
      applicationId: application.id,
      ownerUserId: null,
      title: "Financials",
      documentType: "financial_statement",
    });

    await createDocumentVersion({
      documentId: document.id,
      version: 1,
      metadata: { fileName: "financials.pdf", mimeType: "application/pdf", size: 100 },
      content: Buffer.from("pdf-data").toString("base64"),
    });

    await insertDocumentOcrFields({
      documentId: document.id,
      applicationId: application.id,
      documentType: "financial_statement",
      fields: [
        { fieldKey: "business_name", value: "Acme Inc", confidence: 0.96 },
        { fieldKey: "tax_id", value: "12-3456789", confidence: 0.91 },
        { fieldKey: "owner_name", value: "Jane Doe", confidence: 0.92 },
      ],
    });

    const response = await request(app)
      .get("/api/applications")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId);

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    const [item] = response.body.items;
    expect(item.ocrInsights).toBeDefined();
    expect(item.ocrInsights.fields.business_name.value).toBe("acme inc");
    expect(item.ocrInsights.missingFields).toEqual([]);
    expect(item.ocrInsights.conflictingFields).toEqual([]);
    expect(item.ocrInsights.groupedByDocumentType.financial_statement).toBeDefined();
    expect(item.ocrInsights.groupedByFieldCategory.general).toBeDefined();
    expect(item.ocrInsights.groupedByFieldCategory.taxes).toBeDefined();
  });

  it("returns grouped OCR insights for an application", async () => {
    const token = await loginAdmin();

    const application = await createApplication({
      ownerUserId: null,
      name: "OCR Grouping",
      metadata: null,
      productType: "standard",
    });

    const document = await createDocument({
      applicationId: application.id,
      ownerUserId: null,
      title: "Contracts",
      documentType: "contracts",
    });

    await createDocumentVersion({
      documentId: document.id,
      version: 1,
      metadata: { fileName: "contracts.pdf", mimeType: "application/pdf", size: 100 },
      content: Buffer.from("pdf-data").toString("base64"),
    });

    await insertDocumentOcrFields({
      documentId: document.id,
      applicationId: application.id,
      documentType: "contracts",
      fields: [
        { fieldKey: "contract_term", value: "12 months", confidence: 0.9 },
      ],
    });

    const response = await request(app)
      .get(`/api/applications/${application.id}/ocr-insights`)
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", requestId);

    expect(response.status).toBe(200);
    expect(response.body.ocrInsights.groupedByDocumentType.contracts).toBeDefined();
    expect(response.body.ocrInsights.groupedByFieldCategory.contracts).toBeDefined();
  });
});
