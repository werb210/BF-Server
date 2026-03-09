import { Router, type Request } from "express";
import { randomUUID } from "crypto";
import multer from "multer";
import { AppError } from "../middleware/errors";
import { validateFile } from "../utils/fileValidation";
import { uploadDocumentBuffer } from "../services/storage/blobStorage";
import { safeHandler } from "../middleware/safeHandler";
import { requireAuth, requireCapability } from "../middleware/auth";
import { CAPABILITIES } from "../auth/capabilities";
import { isRole } from "../auth/roles";
import {
  createDocument,
  createDocumentVersion,
  findActiveDocumentVersion,
  findApplicationById,
  findDocumentById,
  getLatestDocumentVersion,
  upsertApplicationRequiredDocument,
  updateDocumentUploadDetails,
  listApplicationRequiredDocuments,
} from "../modules/applications/applications.repo";
import { getDocumentMaxSizeBytes } from "../config";
import {
  acceptDocument,
  rejectDocument,
} from "../modules/applications/applications.service";
import { resolveRequirementsForApplication } from "../services/lenderProductRequirementsService";
import { normalizeRequiredDocumentKey } from "../db/schema/requiredDocuments";
import {
  createBankingAnalysisJob,
  createDocumentProcessingJob,
} from "../modules/processing/processing.service";
import { eventBus } from "../events/eventBus";

const BANK_STATEMENT_CATEGORY = "bank_statements_6_months";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: getDocumentMaxSizeBytes(),
  },
  fileFilter: (_req, file, cb) => {
    const allowedMimeTypes = new Set([
      "application/pdf",
      "image/png",
      "image/jpeg",
    ]);
    if (!allowedMimeTypes.has(file.mimetype)) {
      cb(new AppError("validation_error", "Invalid file type.", 400));
      return;
    }
    cb(null, true);
  },
});

const router = Router();

function buildRequestMetadata(req: Request): { ip?: string; userAgent?: string } {
  const metadata: { ip?: string; userAgent?: string } = {};
  if (req.ip) {
    metadata.ip = req.ip;
  }
  const userAgent = req.get("user-agent");
  if (userAgent) {
    metadata.userAgent = userAgent;
  }
  return metadata;
}

const uploadHandler = safeHandler(async (req, res) => {
  const applicationId = typeof req.body?.applicationId === "string"
    ? req.body.applicationId.trim()
    : "";
  const category =
    typeof req.body?.category === "string" ? req.body.category.trim() : "";
  if (!applicationId) {
    throw new AppError("validation_error", "applicationId is required.", 400);
  }
  if (!category) {
    throw new AppError("validation_error", "category is required.", 400);
  }
  if (!req.file) {
    throw new AppError("validation_error", "file is required.", 400);
  }

  const application = await findApplicationById(applicationId);
  if (!application) {
    throw new AppError("not_found", "Application not found.", 404);
  }

  const { requirements } = await resolveRequirementsForApplication({
    lenderProductId: application.lender_product_id ?? null,
    productType: application.product_type,
    requestedAmount: application.requested_amount ?? null,
    country:
      typeof application.metadata === "object" && application.metadata !== null
        ? (application.metadata as { country?: string }).country ?? null
        : null,
  });
  const normalizedCategory = normalizeRequiredDocumentKey(category) ?? category;
  const requirement = requirements.find((item) => {
    const normalizedRequirement = normalizeRequiredDocumentKey(item.documentType);
    if (normalizedRequirement) {
      return normalizedRequirement === normalizedCategory;
    }
    return item.documentType === category;
  });
  if (!requirement) {
    throw new AppError("invalid_document_type", "Document type is not allowed.", 400);
  }

  const safeFileId = randomUUID();
  const extension = req.file.originalname.includes(".")
    ? req.file.originalname.split(".").pop()
    : "bin";
  const safeFilename = `${safeFileId}.${extension}`;

  const document = await createDocument({
    applicationId,
    ownerUserId: application.owner_user_id,
    title: safeFilename,
    documentType: category,
    filename: safeFilename,
    uploadedBy: "client",
  });
  const fileType = await validateFile(req.file.buffer);
  const nextVersion = (await getLatestDocumentVersion(document.id)) + 1;
  const uploaded = await uploadDocumentBuffer({
    buffer: req.file.buffer,
    filename: safeFilename,
    contentType: fileType.mime,
  });
  await createDocumentVersion({
    documentId: document.id,
    version: nextVersion,
    blobName: uploaded.blobName,
    hash: uploaded.hash,
    metadata: {
      fileName: safeFilename,
      mimeType: fileType.mime,
      size: req.file.size,
      storageKey: uploaded.blobName,
      storageUrl: uploaded.url,
      hash: uploaded.hash,
    },
    content: "",
  });
  await updateDocumentUploadDetails({
    documentId: document.id,
    status: "uploaded",
    filename: safeFilename,
    storageKey: uploaded.blobName,
    uploadedBy: "client",
  });
  await upsertApplicationRequiredDocument({
    applicationId,
    documentCategory: normalizedCategory,
    isRequired: requirement.required !== false,
    status: "uploaded",
  });

  eventBus.emit("document_uploaded", {
    documentId: document.id,
    applicationId,
  });

  const requiredDocs = await listApplicationRequiredDocuments({ applicationId });
  const requiredComplete = requiredDocs
    .filter((item) => item.is_required)
    .every((item) => item.status === "uploaded" || item.status === "accepted");
  if (requiredComplete) {
    eventBus.emit("documents_complete", { applicationId });
  }

  if (normalizedCategory === BANK_STATEMENT_CATEGORY) {
    await createBankingAnalysisJob(applicationId);
  } else {
    await createDocumentProcessingJob(applicationId, document.id);
  }

  res.status(201).json({
    documentId: document.id,
    applicationId,
    category,
    filename: safeFilename,
    size: req.file.size,
    storageKey: uploaded.blobName,
    createdAt: document.created_at,
  });
});

router.post("/", upload.single("file"), uploadHandler);
router.post("/upload", upload.single("file"), uploadHandler);

router.get(
  "/:id/presign",
  safeHandler(async (req, res) => {
    const documentId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!documentId) {
      throw new AppError("validation_error", "documentId is required.", 400);
    }
    const document = await findDocumentById(documentId);
    if (!document) {
      throw new AppError("not_found", "Document not found.", 404);
    }
    const version = await findActiveDocumentVersion({ documentId: document.id });
    if (!version) {
      throw new AppError("not_found", "Document version not found.", 404);
    }
    const metadata =
      version.metadata && typeof version.metadata === "object"
        ? (version.metadata as {
            fileName?: string;
            mimeType?: string;
            size?: number;
            storageKey?: string;
          })
        : {};
    const storageKey = metadata.storageKey ?? null;
    res.status(200).json({
      documentId: document.id,
      version: version.version,
      filename: metadata.fileName ?? document.title,
      mimeType: metadata.mimeType ?? null,
      size: metadata.size ?? null,
      storageKey,
      url: storageKey ? `/api/documents/${document.id}/download?key=${storageKey}` : null,
    });
  })
);

router.post(
  "/:id/accept",
  requireAuth,
  requireCapability([CAPABILITIES.DOCUMENT_REVIEW]),
  safeHandler(async (req, res) => {
    if (!req.user) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    if (!isRole(req.user.role)) {
      throw new AppError("forbidden", "Not authorized.", 403);
    }
    const documentId = req.params.id;
    if (!documentId) {
      throw new AppError("validation_error", "document id is required.", 400);
    }
    await acceptDocument({
      documentId,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      ...buildRequestMetadata(req),
    });
    res.status(200).json({ success: true, data: { accepted: true } });
  })
);

router.post(
  "/:id/reject",
  requireAuth,
  requireCapability([CAPABILITIES.DOCUMENT_REVIEW]),
  safeHandler(async (req, res) => {
    if (!req.user) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    if (!isRole(req.user.role)) {
      throw new AppError("forbidden", "Not authorized.", 403);
    }
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) {
      throw new AppError("validation_error", "Rejection reason is required.", 400);
    }
    const documentId = req.params.id;
    if (!documentId) {
      throw new AppError("validation_error", "document id is required.", 400);
    }
    await rejectDocument({
      documentId,
      rejectionReason: reason,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      ...buildRequestMetadata(req),
    });
    res.status(200).json({ success: true, data: { rejected: true } });
  })
);

export default router;
