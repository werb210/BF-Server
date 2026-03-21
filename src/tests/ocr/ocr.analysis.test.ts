import { describe, it, expect } from 'vitest';
import { pool } from "../../db";
import {
  createApplication,
  createDocument,
  createDocumentVersion,
} from "../../modules/applications/applications.repo";
import { insertDocumentOcrFields } from "../../modules/ocr/ocr.repo";
import { analyzeOcrForApplication } from "../../modules/applications/ocr/ocrAnalysis.service";
import { ensureOcrTestSchema, resetOcrTestSchema } from "./ocrTestSchema";

async function seedDocument(applicationId: string, title: string): Promise<string> {
  const document = await createDocument({
    applicationId,
    ownerUserId: null,
    title,
    documentType: title.toLowerCase().replace(/\s+/g, "_"),
  });
  await createDocumentVersion({
    documentId: document.id,
    version: 1,
    metadata: { fileName: `${title}.pdf`, mimeType: "application/pdf", size: 100 },
    content: Buffer.from("pdf-data").toString("base64"),
  });
  return document.id;
}

describe("OCR analysis", () => {
  beforeAll(async () => {
    await ensureOcrTestSchema();
  });

  beforeEach(async () => {
    await resetOcrTestSchema();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("detects missing required fields and conflicts with tolerance", async () => {
    const application = await createApplication({
      ownerUserId: null,
      name: "OCR Analysis",
      metadata: null,
      productType: "standard",
    });

    const documentA = await seedDocument(application.id, "Financial Statement");
    const documentB = await seedDocument(application.id, "Tax Return");

    await insertDocumentOcrFields({
      documentId: documentA,
      applicationId: application.id,
      documentType: "financial_statement",
      fields: [
        { fieldKey: "business_name", value: "Acme Inc", confidence: 0.98 },
        { fieldKey: "total_revenue", value: "1000", confidence: 0.9 },
        { fieldKey: "total_revenue", value: "1005", confidence: 0.88 },
      ],
    });

    await insertDocumentOcrFields({
      documentId: documentB,
      applicationId: application.id,
      documentType: "tax_return",
      fields: [
        { fieldKey: "total_revenue", value: "1300", confidence: 0.82 },
      ],
    });

    const summary = await analyzeOcrForApplication(application.id);

    expect(summary.missingFields).toContain("tax_id");
    expect(summary.missingFields).toContain("owner_name");
    expect(summary.conflictingFields).toContain("total_revenue");
    expect(summary.complete).toBe(false);
    expect(summary.warnings).toEqual(
      expect.arrayContaining(["Missing Tax ID", "Missing Owner Name", "Conflicting Total Revenue"])
    );
  });
});
