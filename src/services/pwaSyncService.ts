import { createHash, randomUUID } from "crypto";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import { pool } from "../db";
import { findIdempotencyRecord, createIdempotencyRecord } from "../modules/idempotency/idempotency.repo";
import { CAPABILITIES } from "../auth/capabilities";
import { ROLES, normalizeRole } from "../auth/roles";
import { createUserAccount } from "../modules/auth/auth.service";
import { createLender } from "../repositories/lenders.repo";
import { createLenderProductService } from "./lenderProductsService";
import { fetchLenderById } from "../repositories/lenders.repo";
import { trackEvent } from "../observability/appInsights";
import { logInfo } from "../observability/logger";
import { type JsonObject, type JsonValue, type RequiredDocuments } from "../db/schema/lenderProducts";
import {
  ALWAYS_REQUIRED_DOCUMENTS,
  normalizeRequiredDocumentKey,
  type RequiredDocumentKey,
} from "../db/schema/requiredDocuments";
import { config } from "@/config";

type ReplayUserContext = {
  userId: string;
  role: string;
  lenderId?: string | null;
  capabilities: string[];
};

type ReplayAction = {
  id: string;
  method: "POST";
  path: string;
  body: Record<string, unknown>;
  idempotencyKey: string;
};

export type ReplayResult = {
  id: string;
  status: "succeeded" | "failed" | "skipped";
  statusCode: number;
  response?: unknown;
  error?: { code: string; message: string };
  cached?: boolean;
};

const jwtRegex = /^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/;

const replaySchema = z.object({
  actions: z.array(
    z.object({
      id: z.string().min(1),
      method: z.literal("POST"),
      path: z.string().min(1),
      body: z.record(z.string(), z.unknown()).optional(),
      idempotencyKey: z.string().min(1),
    })
  ),
});

const lenderSchema = z.object({
  name: z.string().min(1),
  country: z.string().min(1),
  submissionMethod: z.string().optional(),
  active: z.boolean().optional(),
  website: z.string().optional(),
  submissionEmail: z.string().email().optional(),
  apiConfig: z.record(z.string(), z.unknown()).optional(),
  submissionConfig: z.record(z.string(), z.unknown()).optional(),
  primaryContactName: z.string().optional(),
  primaryContactEmail: z.string().email().optional(),
  primaryContactPhone: z.string().optional(),
});

const lenderProductSchema = z.object({
  lenderId: z.string().uuid(),
  name: z.string().optional(),
  active: z.boolean().optional(),
  required_documents: z.array(z.record(z.string(), z.unknown())).optional(),
  category: z.string().optional(),
  country: z.string().optional(),
  rate_type: z.string().optional(),
  interest_min: z.string().optional(),
  interest_max: z.string().optional(),
  term_min: z.number().optional(),
  term_max: z.number().optional(),
});

const userSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().min(1).optional(),
  role: z.string().min(1),
  lenderId: z.string().uuid().optional(),
});

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function toRequiredDocumentEntry(key: RequiredDocumentKey): JsonObject {
  return { type: key, document_key: key };
}

function requireRequiredDocuments(value: unknown): RequiredDocuments {
  if (!Array.isArray(value)) {
    throw new AppError("validation_error", "required_documents must be an array.", 400);
  }

  const normalized: RequiredDocuments = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const normalizedKey = normalizeRequiredDocumentKey(entry);
      if (!normalizedKey) {
        throw new AppError(
          "validation_error",
          "required_documents contains invalid keys.",
          400
        );
      }
      normalized.push(toRequiredDocumentEntry(normalizedKey));
      continue;
    }
    if (isJsonObject(entry)) {
      const rawType =
        typeof entry.type === "string"
          ? entry.type
          : typeof entry.documentType === "string"
            ? entry.documentType
            : typeof entry.document_key === "string"
              ? entry.document_key
              : typeof entry.key === "string"
                ? entry.key
                : null;
      if (!rawType) {
        continue;
      }
      const normalizedKey = normalizeRequiredDocumentKey(rawType);
      if (!normalizedKey) {
        throw new AppError(
          "validation_error",
          "required_documents contains invalid keys.",
          400
        );
      }
      normalized.push({ ...entry, type: normalizedKey, document_key: normalizedKey });
      continue;
    }
    throw new AppError(
      "validation_error",
      "required_documents must contain strings or objects.",
      400
    );
  }

  const existing = new Set(
    normalized
      .map((doc) => {
        const rawType =
          typeof doc.document_key === "string"
            ? doc.document_key
            : typeof doc.type === "string"
              ? doc.type
              : typeof doc.documentType === "string"
                ? doc.documentType
                : typeof doc.key === "string"
                  ? doc.key
                  : null;
        return rawType ? normalizeRequiredDocumentKey(rawType) : null;
      })
      .filter((key): key is RequiredDocumentKey => Boolean(key))
  );

  ALWAYS_REQUIRED_DOCUMENTS.forEach((doc) => {
    if (!existing.has(doc)) {
      normalized.push(toRequiredDocumentEntry(doc));
    }
  });

  return normalized;
}

function normalizeVariableRateString(value: string | undefined, fieldName: string): string {
  if (!value || value.trim().length === 0) {
    throw new AppError(
      "validation_error",
      `${fieldName} is required for VARIABLE rates.`,
      400
    );
  }
  const trimmed = value.trim();
  const primeMatch =
    trimmed.match(/^p\\+\\s*(.+)$/i) ?? trimmed.match(/^prime\\s*\\+\\s*(.+)$/i);
  if (primeMatch?.[1]) {
    return `Prime + ${primeMatch[1].trim()}`;
  }
  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric)) {
    return `Prime + ${trimmed}`;
  }
  throw new AppError(
    "validation_error",
    `${fieldName} must be a number or Prime + X.`,
    400
  );
}

function isLenderActive(lender: unknown): boolean {
  const status =
    typeof (lender as { status?: unknown }).status === "string"
      ? (lender as { status?: string }).status
      : null;
  const activeFlag =
    typeof (lender as { active?: unknown }).active === "boolean"
      ? (lender as { active: boolean }).active
      : null;
  if (activeFlag !== null) {
    return activeFlag;
  }
  return status === "ACTIVE";
}

function assertActionPayloadSize(body: unknown): void {
  const maxBytes = config.pwa.syncActionMaxBytes;
  const size = Buffer.byteLength(JSON.stringify(body ?? {}), "utf8");
  if (size > maxBytes) {
    throw new AppError(
      "payload_too_large",
      `Replay payload exceeds ${maxBytes} bytes.`,
      413
    );
  }
}

function containsJwt(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    return jwtRegex.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsJwt);
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([key, entry]) => {
      const lowered = key.toLowerCase();
      if (["authorization", "accesstoken", "refreshtoken", "jwt"].includes(lowered)) {
        return true;
      }
      return containsJwt(entry);
    });
  }
  return false;
}

function assertCapabilities(user: ReplayUserContext, required: string[]): void {
  if (user.capabilities.includes(CAPABILITIES.OPS_MANAGE)) {
    return;
  }
  const hasAll = required.every((cap) => user.capabilities.includes(cap));
  if (!hasAll) {
    throw new AppError(
      "insufficient_capabilities",
      "User lacks required capabilities.",
      403
    );
  }
}

async function executeReplayAction(
  action: ReplayAction,
  user: ReplayUserContext
): Promise<{ statusCode: number; body: unknown }> {
  if (action.path === "/api/lenders") {
    assertCapabilities(user, [CAPABILITIES.OPS_MANAGE]);
    const parsedResult = lenderSchema.safeParse(action.body);
    if (!parsedResult.success) {
      throw new AppError("validation_error", "Invalid lender payload.", 400);
    }
    const parsed = parsedResult.data;
    const createPayload = {
      name: parsed.name.trim(),
      country: parsed.country.trim(),
      submission_method: parsed.submissionMethod?.trim().toLowerCase() ?? "email",
      website: parsed.website ?? null,
      submission_email: parsed.submissionEmail ?? null,
      api_config: parsed.apiConfig ?? null,
      submission_config: parsed.submissionConfig ?? parsed.apiConfig ?? null,
      primary_contact_name: parsed.primaryContactName ?? null,
      primary_contact_email: parsed.primaryContactEmail ?? null,
      primary_contact_phone: parsed.primaryContactPhone ?? null,
      ...(typeof parsed.active === "boolean" ? { active: parsed.active } : {}),
    };
    const lender = await createLender(pool, createPayload);
    return { statusCode: 201, body: lender };
  }

  if (action.path === "/api/lender-products") {
    assertCapabilities(user, [CAPABILITIES.LENDER_PRODUCTS_WRITE]);
    const parsedResult = lenderProductSchema.safeParse(action.body);
    if (!parsedResult.success) {
      throw new AppError("validation_error", "Invalid lender product payload.", 400);
    }
    const parsed = parsedResult.data;
    if (user.role === ROLES.LENDER) {
      if (!user.lenderId) {
        throw new AppError(
          "invalid_lender_binding",
          "lender_id is required for Lender users.",
          400
        );
      }
      if (parsed.lenderId !== user.lenderId) {
        throw new AppError("forbidden", "Access denied.", 403);
      }
    }
    const lender = await fetchLenderById(parsed.lenderId);
    if (!lender) {
      throw new AppError("not_found", "Lender not found.", 404);
    }
    if (!isLenderActive(lender)) {
      throw new AppError(
        "lender_inactive",
        "Lender must be active to add products.",
        400
      );
    }
    const requiredDocuments = requireRequiredDocuments(
      parsed.required_documents ?? []
    );
    const normalizedRateType =
      typeof parsed.rate_type === "string" ? parsed.rate_type.trim().toUpperCase() : null;
    const interestMin =
      normalizedRateType === "VARIABLE"
        ? normalizeVariableRateString(parsed.interest_min, "interest_min")
        : parsed.interest_min ?? null;
    const interestMax =
      normalizedRateType === "VARIABLE"
        ? normalizeVariableRateString(parsed.interest_max, "interest_max")
        : parsed.interest_max ?? null;
    const created = await createLenderProductService({
      lenderId: parsed.lenderId,
      name: parsed.name ?? null,
      active: parsed.active ?? true,
      category: parsed.category,
      requiredDocuments,
      country: parsed.country ?? null,
      rateType: normalizedRateType,
      interestMin,
      interestMax,
      termMin: parsed.term_min ?? null,
      termMax: parsed.term_max ?? null,
    });
    return { statusCode: 201, body: created };
  }

  if (action.path === "/api/users") {
    if (user.role !== ROLES.ADMIN) {
      throw new AppError("forbidden", "Access denied.", 403);
    }
    const parsedResult = userSchema.safeParse(action.body);
    if (!parsedResult.success) {
      throw new AppError("validation_error", "Invalid user payload.", 400);
    }
    const parsed = parsedResult.data;
    const normalizedRole = normalizeRole(parsed.role);
    if (!normalizedRole) {
      throw new AppError("validation_error", "Role is invalid.", 400);
    }
    const created = await createUserAccount({
      email: parsed.email ?? null,
      phoneNumber: parsed.phone ?? null,
      role: normalizedRole,
      lenderId: parsed.lenderId ?? null,
      actorUserId: user.userId,
    });
    return { statusCode: 201, body: created };
  }

  throw new AppError("unsupported_replay", "Replay action is not supported.", 400);
}

export async function replaySyncBatch(params: {
  user: ReplayUserContext;
  payload: unknown;
  requestId: string;
}): Promise<{ batchId: string; results: ReplayResult[] }> {
  const parsedResult = replaySchema.safeParse(params.payload);
  if (!parsedResult.success) {
    throw new AppError("validation_error", "Invalid replay payload.", 400);
  }
  const parsed = parsedResult.data;
  if (parsed.actions.length === 0) {
    throw new AppError("validation_error", "No actions provided.", 400);
  }
  const maxActions = config.pwa.syncMaxActions;
  if (parsed.actions.length > maxActions) {
    throw new AppError(
      "too_many_actions",
      `Replay batch exceeds ${maxActions} actions.`,
      413
    );
  }

  const batchSize = Buffer.byteLength(JSON.stringify(parsed), "utf8");
  const maxBatchBytes = config.pwa.syncBatchMaxBytes;
  if (batchSize > maxBatchBytes) {
    throw new AppError(
      "payload_too_large",
      `Replay batch exceeds ${maxBatchBytes} bytes.`,
      413
    );
  }

  const batchId = randomUUID();
  logInfo("pwa_replay_batch_start", {
    batchId,
    requestId: params.requestId,
    count: parsed.actions.length,
    userId: params.user.userId,
  });

  const results: ReplayResult[] = [];
  let failed = false;

  for (const action of parsed.actions) {
    if (failed) {
      results.push({
        id: action.id,
        status: "skipped",
        statusCode: 409,
        error: { code: "batch_aborted", message: "Replay batch aborted." },
      });
      continue;
    }

    try {
      if (!action.idempotencyKey || action.idempotencyKey.length > 128) {
        throw new AppError(
          "missing_idempotency_key",
          "Idempotency-Key is required.",
          400
        );
      }
      if (containsJwt(action.body)) {
        throw new AppError(
          "jwt_not_allowed",
          "JWT tokens are not allowed in replay payloads.",
          400
        );
      }
      assertActionPayloadSize(action.body ?? {});
      const sanitizedBody = sanitizeJson(action.body ?? {});
      const requestHash = hashValue(stableStringify(sanitizedBody));
      const idempotencyKey = action.idempotencyKey.trim();

      const existing = await findIdempotencyRecord({
        route: action.path,
        idempotencyKey,
      });

      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new AppError(
            "idempotency_conflict",
            "Idempotency key reused with different payload.",
            409
          );
        }
        results.push({
          id: action.id,
          status: "succeeded",
          statusCode: existing.response_code,
          response: existing.response_body,
          cached: true,
        });
        continue;
      }

      const { statusCode, body } = await executeReplayAction(
        {
          id: action.id,
          method: action.method,
          path: action.path,
          body: sanitizedBody,
          idempotencyKey,
        },
        params.user
      );

      await createIdempotencyRecord({
        route: action.path,
        idempotencyKey,
        method: action.method,
        requestHash,
        responseCode: statusCode,
        responseBody: body,
      });

      results.push({
        id: action.id,
        status: "succeeded",
        statusCode,
        response: body,
      });

      trackEvent({
        name: "replay_success",
        properties: {
          batchId,
          requestId: params.requestId,
          actionId: action.id,
          path: action.path,
          userId: params.user.userId,
        },
      });
    } catch (error) {
      failed = true;
      const appError =
        error instanceof AppError
          ? error
          : new AppError("replay_failed", "Replay failed.", 500);
      results.push({
        id: action.id,
        status: "failed",
        statusCode: appError.status,
        error: { code: appError.code, message: appError.message },
      });
      trackEvent({
        name: "replay_failed",
        properties: {
          batchId,
          requestId: params.requestId,
          actionId: action.id,
          path: action.path,
          userId: params.user.userId,
          error: appError.code,
        },
      });
    }
  }

  logInfo("pwa_replay_batch_complete", {
    batchId,
    requestId: params.requestId,
    results: {
      total: results.length,
      failed: results.filter((res) => res.status === "failed").length,
      succeeded: results.filter((res) => res.status === "succeeded").length,
      skipped: results.filter((res) => res.status === "skipped").length,
    },
  });

  return { batchId, results };
}
