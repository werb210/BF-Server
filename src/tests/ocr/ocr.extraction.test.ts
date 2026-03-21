import { randomUUID } from "crypto";
import { pool } from "../../db";
import {
  createApplication,
  createDocument,
  createDocumentVersion,
} from "../../modules/applications/applications.repo";
import { type OcrJobRecord } from "../../modules/ocr/ocr.types";
import { extractOcrFields, processOcrJob } from "../../modules/ocr/ocr.service";
import { getOcrFieldRegistry } from "../../ocr/ocrFieldRegistry";
import { ensureOcrTestSchema, resetOcrTestSchema } from "./ocrTestSchema";

const mockStorage = {
  getBuffer: vi.fn().mockResolvedValue(Buffer.from("pdf")),
};

const mockProvider = {
  extract: vi.fn(async (params: { fileName?: string }) => {
    const fileName = params.fileName ?? "unknown";
    if (fileName.includes("financial")) {
      return {
        text: "Business Name: Acme Inc\nTotal Revenue: $1,200\nUnknown Field: nope",
        json: null,
        meta: null,
        model: "test-model",
        provider: "test",
      };
    }
    if (fileName.includes("tax")) {
      return {
        text: "Tax ID: 12-3456789\nOwner Name: Jane Doe",
        json: null,
        meta: null,
        model: "test-model",
        provider: "test",
      };
    }
    if (fileName.includes("inventory")) {
      return {
        text: "Inventory Value: $5,000",
        json: null,
        meta: null,
        model: "test-model",
        provider: "test",
      };
    }
    return {
      text: "Contract Term: 12 months",
      json: null,
      meta: null,
      model: "test-model",
      provider: "test",
    };
  }),
};

async function seedDocument(params: {
  applicationId: string;
  documentType: string;
  title: string;
  fileName: string;
}): Promise<string> {
  const document = await createDocument({
    applicationId: params.applicationId,
    ownerUserId: null,
    title: params.title,
    documentType: params.documentType,
  });
  await createDocumentVersion({
    documentId: document.id,
    version: 1,
    metadata: { fileName: params.fileName, mimeType: "application/pdf", size: 100 },
    content: Buffer.from("pdf-data").toString("base64"),
  });
  return document.id;
}

async function createOcrJobRecord(params: {
  documentId: string;
  applicationId: string;
}): Promise<OcrJobRecord> {
  const jobId = randomUUID();
  const result = await pool.query<OcrJobRecord>(
    `insert into ocr_jobs\n     (id, document_id, application_id, status, attempt_count, max_attempts, next_attempt_at, created_at, updated_at)\n     values ($1, $2, $3, 'queued', 0, 2, null, now(), now())\n     returning id, document_id, application_id, status, attempt_count, max_attempts,\n               next_attempt_at, locked_at, locked_by, last_error, created_at, updated_at`,
    [jobId, params.documentId, params.applicationId]
  );
  return result.rows[0];
}

describe("OCR extraction pipeline", () => {
  beforeAll(async () => {
    await ensureOcrTestSchema();
  });

  beforeEach(async () => {
    await resetOcrTestSchema();
    mockProvider.extract.mockClear();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("runs OCR on all document types and extracts only registry fields", async () => {
    const application = await createApplication({
      ownerUserId: null,
      name: "OCR App",
      metadata: null,
      productType: "standard",
    });

    const documentIds = await Promise.all([
      seedDocument({
        applicationId: application.id,
        documentType: "financial_statement",
        title: "Financials",
        fileName: "financials.pdf",
      }),
      seedDocument({
        applicationId: application.id,
        documentType: "tax_return",
        title: "Tax Return",
        fileName: "tax-return.pdf",
      }),
      seedDocument({
        applicationId: application.id,
        documentType: "inventory_list",
        title: "Inventory",
        fileName: "inventory.pdf",
      }),
      seedDocument({
        applicationId: application.id,
        documentType: "contract",
        title: "Contract",
        fileName: "contract.pdf",
      }),
    ]);

    for (const documentId of documentIds) {
      const job = await createOcrJobRecord({
        documentId,
        applicationId: application.id,
      });
      await processOcrJob(job, { provider: mockProvider, storage: mockStorage });
    }

    const registryKeys = new Set(getOcrFieldRegistry().map((field) => field.field_key));
    const extractedKeys = extractOcrFields(
      "Business Name: Acme Inc\nTotal Revenue: $1,200\nUnknown Field: nope"
    ).map((field) => field.fieldKey);

    extractedKeys.forEach((key) => {
      expect(registryKeys.has(key)).toBe(true);
      expect(key).not.toBe("unknown_field");
    });

    expect(mockProvider.extract).toHaveBeenCalledTimes(documentIds.length);
    expect(mockProvider.extract).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "financials.pdf" })
    );
    expect(mockProvider.extract).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "tax-return.pdf" })
    );
    expect(mockProvider.extract).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "inventory.pdf" })
    );
    expect(mockProvider.extract).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "contract.pdf" })
    );
  });
});
