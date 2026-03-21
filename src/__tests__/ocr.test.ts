import { randomUUID } from "crypto";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import {
  createApplication,
  createDocument,
  createDocumentVersion,
} from "../modules/applications/applications.repo";
import {
  createOcrJob,
  findOcrJobByDocumentId,
  lockOcrJobs,
} from "../modules/ocr/ocr.repo";
import { processOcrJob } from "../modules/ocr/ocr.service";
import { ensureAuditEventSchema } from "./helpers/auditSchema";

async function seedDocument(): Promise<{ documentId: string; applicationId: string }> {
  const phone = `+1415${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const user = await createUserAccount({
    email: `ocr-${randomUUID()}@example.com`,
    phoneNumber: phone,
    role: ROLES.REFERRER,
  });
  const application = await createApplication({
    ownerUserId: user.id,
    name: "OCR App",
    metadata: null,
    productType: "standard",
  });
  const document = await createDocument({
    applicationId: application.id,
    ownerUserId: user.id,
    title: "Bank Statement",
    documentType: "bank_statement",
  });
  await createDocumentVersion({
    documentId: document.id,
    version: 1,
    metadata: { fileName: "bank.pdf", mimeType: "application/pdf", size: 100 },
    content: Buffer.from("pdf-data").toString("base64"),
  });
  return { documentId: document.id, applicationId: application.id };
}

describe("ocr jobs", () => {
  beforeAll(async () => {
    await ensureAuditEventSchema();
  });

  beforeEach(async () => {
    await pool.query("delete from ocr_results");
    await pool.query("delete from ocr_document_results");
    await pool.query("delete from ocr_jobs");
    await pool.query("delete from document_version_reviews");
    await pool.query("delete from document_versions");
    await pool.query("delete from documents");
    await pool.query("delete from applications");
    await pool.query("delete from users");
  });

  it("creates OCR jobs idempotently", async () => {
    const { documentId, applicationId } = await seedDocument();

    const first = await createOcrJob({
      documentId,
      applicationId,
      maxAttempts: 3,
    });
    const second = await createOcrJob({
      documentId,
      applicationId,
      maxAttempts: 3,
    });

    expect(first.id).toEqual(second.id);
    const count = await pool.query<{ count: string }>(
      "select count(*) from ocr_jobs where document_id = $1",
      [documentId]
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it("locks OCR jobs safely", async () => {
    const { documentId, applicationId } = await seedDocument();

    await createOcrJob({
      documentId,
      applicationId,
      maxAttempts: 2,
    });

    const [locked] = await lockOcrJobs({ limit: 1, lockedBy: "worker-1" });
    expect(locked).toBeDefined();
    expect(locked.status).toBe("processing");

    const secondLock = await lockOcrJobs({ limit: 1, lockedBy: "worker-2" });
    expect(secondLock).toHaveLength(0);
  });

  it("reclaims OCR jobs with expired locks", async () => {
    const { documentId, applicationId } = await seedDocument();

    const job = await createOcrJob({
      documentId,
      applicationId,
      maxAttempts: 2,
    });

    const [locked] = await lockOcrJobs({ limit: 1, lockedBy: "worker-1" });
    expect(locked?.id).toBe(job.id);

    const expired = new Date(Date.now() - 20 * 60 * 1000);
    await pool.query(
      `update ocr_jobs
       set locked_at = $2
       where id = $1`,
      [job.id, expired]
    );

    const reclaimed = await lockOcrJobs({ limit: 1, lockedBy: "worker-2" });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].id).toBe(job.id);
    expect(reclaimed[0].locked_by).toBe("worker-2");
  });

  it("bounds retries with exponential backoff", async () => {
    const { documentId, applicationId } = await seedDocument();
    const job = await createOcrJob({
      documentId,
      applicationId,
      maxAttempts: 2,
    });

    const mockProvider = {
      extract: vi.fn().mockRejectedValue(new Error("provider_failed")),
    };
    const mockStorage = {
      getBuffer: vi.fn().mockResolvedValue(Buffer.from("data")),
    };

    await processOcrJob(job, { provider: mockProvider, storage: mockStorage });
    const firstFailure = await findOcrJobByDocumentId(documentId);
    expect(firstFailure?.status).toBe("failed");
    expect(firstFailure?.attempt_count).toBe(1);

    await processOcrJob(firstFailure!, { provider: mockProvider, storage: mockStorage });
    const secondFailure = await findOcrJobByDocumentId(documentId);
    expect(secondFailure?.status).toBe("canceled");
    expect(secondFailure?.attempt_count).toBe(2);
  });
});
