"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.replaySyncBatch = replaySyncBatch;
const crypto_1 = require("crypto");
const zod_1 = require("zod");
const errors_1 = require("../middleware/errors");
const db_1 = require("../db");
const idempotency_repo_1 = require("../modules/idempotency/idempotency.repo");
const capabilities_1 = require("../auth/capabilities");
const roles_1 = require("../auth/roles");
const auth_service_1 = require("../modules/auth/auth.service");
const lenders_repo_1 = require("../repositories/lenders.repo");
const lenderProductsService_1 = require("./lenderProductsService");
const lenders_repo_2 = require("../repositories/lenders.repo");
const appInsights_1 = require("../observability/appInsights");
const logger_1 = require("../observability/logger");
const requiredDocuments_1 = require("../db/schema/requiredDocuments");
const config_1 = require("../config");
const jwtRegex = /^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/;
const replaySchema = zod_1.z.object({
    actions: zod_1.z.array(zod_1.z.object({
        id: zod_1.z.string().min(1),
        method: zod_1.z.literal("POST"),
        path: zod_1.z.string().min(1),
        body: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional(),
        idempotencyKey: zod_1.z.string().min(1),
    })),
});
const lenderSchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    country: zod_1.z.string().min(1),
    submissionMethod: zod_1.z.string().optional(),
    active: zod_1.z.boolean().optional(),
    website: zod_1.z.string().optional(),
    submissionEmail: zod_1.z.string().email().optional(),
    apiConfig: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional(),
    submissionConfig: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional(),
    primaryContactName: zod_1.z.string().optional(),
    primaryContactEmail: zod_1.z.string().email().optional(),
    primaryContactPhone: zod_1.z.string().optional(),
});
const lenderProductSchema = zod_1.z.object({
    lenderId: zod_1.z.string().uuid(),
    name: zod_1.z.string().optional(),
    active: zod_1.z.boolean().optional(),
    required_documents: zod_1.z.array(zod_1.z.record(zod_1.z.string(), zod_1.z.unknown())).optional(),
    category: zod_1.z.string().optional(),
    country: zod_1.z.string().optional(),
    rate_type: zod_1.z.string().optional(),
    interest_min: zod_1.z.string().optional(),
    interest_max: zod_1.z.string().optional(),
    term_min: zod_1.z.number().optional(),
    term_max: zod_1.z.number().optional(),
});
const userSchema = zod_1.z.object({
    email: zod_1.z.string().email().optional(),
    phone: zod_1.z.string().min(1).optional(),
    role: zod_1.z.string().min(1),
    lenderId: zod_1.z.string().uuid().optional(),
});
function stableStringify(value) {
    if (value === null || value === undefined)
        return "null";
    if (typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }
    const record = value;
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
        .join(",")}}`;
}
function hashValue(value) {
    return (0, crypto_1.createHash)("sha256").update(value).digest("hex");
}
function sanitizeJson(value) {
    return JSON.parse(JSON.stringify(value));
}
function isJsonValue(value) {
    if (value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean") {
        return true;
    }
    if (Array.isArray(value)) {
        return value.every(isJsonValue);
    }
    if (typeof value === "object") {
        return Object.values(value).every(isJsonValue);
    }
    return false;
}
function isJsonObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    return Object.values(value).every(isJsonValue);
}
function toRequiredDocumentEntry(key) {
    return { type: key, document_key: key };
}
function requireRequiredDocuments(value) {
    if (!Array.isArray(value)) {
        throw new errors_1.AppError("validation_error", "required_documents must be an array.", 400);
    }
    const normalized = [];
    for (const entry of value) {
        if (typeof entry === "string") {
            const normalizedKey = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(entry);
            if (!normalizedKey) {
                throw new errors_1.AppError("validation_error", "required_documents contains invalid keys.", 400);
            }
            normalized.push(toRequiredDocumentEntry(normalizedKey));
            continue;
        }
        if (isJsonObject(entry)) {
            const rawType = typeof entry.type === "string"
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
            const normalizedKey = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(rawType);
            if (!normalizedKey) {
                throw new errors_1.AppError("validation_error", "required_documents contains invalid keys.", 400);
            }
            normalized.push({ ...entry, type: normalizedKey, document_key: normalizedKey });
            continue;
        }
        throw new errors_1.AppError("validation_error", "required_documents must contain strings or objects.", 400);
    }
    const existing = new Set(normalized
        .map((doc) => {
        const rawType = typeof doc.document_key === "string"
            ? doc.document_key
            : typeof doc.type === "string"
                ? doc.type
                : typeof doc.documentType === "string"
                    ? doc.documentType
                    : typeof doc.key === "string"
                        ? doc.key
                        : null;
        return rawType ? (0, requiredDocuments_1.normalizeRequiredDocumentKey)(rawType) : null;
    })
        .filter((key) => Boolean(key)));
    requiredDocuments_1.ALWAYS_REQUIRED_DOCUMENTS.forEach((doc) => {
        if (!existing.has(doc)) {
            normalized.push(toRequiredDocumentEntry(doc));
        }
    });
    return normalized;
}
function normalizeVariableRateString(value, fieldName) {
    if (!value || value.trim().length === 0) {
        throw new errors_1.AppError("validation_error", `${fieldName} is required for VARIABLE rates.`, 400);
    }
    const trimmed = value.trim();
    const primeMatch = trimmed.match(/^p\\+\\s*(.+)$/i) ?? trimmed.match(/^prime\\s*\\+\\s*(.+)$/i);
    if (primeMatch?.[1]) {
        return `Prime + ${primeMatch[1].trim()}`;
    }
    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) {
        return `Prime + ${trimmed}`;
    }
    throw new errors_1.AppError("validation_error", `${fieldName} must be a number or Prime + X.`, 400);
}
function isLenderActive(lender) {
    const status = typeof lender.status === "string"
        ? lender.status
        : null;
    const activeFlag = typeof lender.active === "boolean"
        ? lender.active
        : null;
    if (activeFlag !== null) {
        return activeFlag;
    }
    return status === "ACTIVE";
}
function assertActionPayloadSize(body) {
    const maxBytes = config_1.config.pwa.syncActionMaxBytes;
    const size = Buffer.byteLength(JSON.stringify(body ?? {}), "utf8");
    if (size > maxBytes) {
        throw new errors_1.AppError("payload_too_large", `Replay payload exceeds ${maxBytes} bytes.`, 413);
    }
}
function containsJwt(value) {
    if (value === null || value === undefined)
        return false;
    if (typeof value === "string") {
        return jwtRegex.test(value);
    }
    if (Array.isArray(value)) {
        return value.some(containsJwt);
    }
    if (typeof value === "object") {
        return Object.entries(value).some(([key, entry]) => {
            const lowered = key.toLowerCase();
            if (["authorization", "accesstoken", "refreshtoken", "jwt"].includes(lowered)) {
                return true;
            }
            return containsJwt(entry);
        });
    }
    return false;
}
function assertCapabilities(user, required) {
    if (user.capabilities.includes(capabilities_1.CAPABILITIES.OPS_MANAGE)) {
        return;
    }
    const hasAll = required.every((cap) => user.capabilities.includes(cap));
    if (!hasAll) {
        throw new errors_1.AppError("insufficient_capabilities", "User lacks required capabilities.", 403);
    }
}
async function executeReplayAction(action, user) {
    if (action.path === "/api/lenders") {
        assertCapabilities(user, [capabilities_1.CAPABILITIES.OPS_MANAGE]);
        const parsedResult = lenderSchema.safeParse(action.body);
        if (!parsedResult.success) {
            throw new errors_1.AppError("validation_error", "Invalid lender payload.", 400);
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
        const lender = await (0, lenders_repo_1.createLender)(db_1.pool, createPayload);
        return { statusCode: 201, body: lender };
    }
    if (action.path === "/api/lender-products") {
        assertCapabilities(user, [capabilities_1.CAPABILITIES.LENDER_PRODUCTS_WRITE]);
        const parsedResult = lenderProductSchema.safeParse(action.body);
        if (!parsedResult.success) {
            throw new errors_1.AppError("validation_error", "Invalid lender product payload.", 400);
        }
        const parsed = parsedResult.data;
        if (user.role === roles_1.ROLES.LENDER) {
            if (!user.lenderId) {
                throw new errors_1.AppError("invalid_lender_binding", "lender_id is required for Lender users.", 400);
            }
            if (parsed.lenderId !== user.lenderId) {
                throw new errors_1.AppError("forbidden", "Access denied.", 403);
            }
        }
        const lender = await (0, lenders_repo_2.fetchLenderById)(parsed.lenderId);
        if (!lender) {
            throw new errors_1.AppError("not_found", "Lender not found.", 404);
        }
        if (!isLenderActive(lender)) {
            throw new errors_1.AppError("lender_inactive", "Lender must be active to add products.", 400);
        }
        const requiredDocuments = requireRequiredDocuments(parsed.required_documents ?? []);
        const normalizedRateType = typeof parsed.rate_type === "string" ? parsed.rate_type.trim().toUpperCase() : null;
        const interestMin = normalizedRateType === "VARIABLE"
            ? normalizeVariableRateString(parsed.interest_min, "interest_min")
            : parsed.interest_min ?? null;
        const interestMax = normalizedRateType === "VARIABLE"
            ? normalizeVariableRateString(parsed.interest_max, "interest_max")
            : parsed.interest_max ?? null;
        const created = await (0, lenderProductsService_1.createLenderProductService)({
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
        if (user.role !== roles_1.ROLES.ADMIN) {
            throw new errors_1.AppError("forbidden", "Access denied.", 403);
        }
        const parsedResult = userSchema.safeParse(action.body);
        if (!parsedResult.success) {
            throw new errors_1.AppError("validation_error", "Invalid user payload.", 400);
        }
        const parsed = parsedResult.data;
        const normalizedRole = (0, roles_1.normalizeRole)(parsed.role);
        if (!normalizedRole) {
            throw new errors_1.AppError("validation_error", "Role is invalid.", 400);
        }
        const created = await (0, auth_service_1.createUserAccount)({
            email: parsed.email ?? null,
            phoneNumber: parsed.phone ?? null,
            role: normalizedRole,
            lenderId: parsed.lenderId ?? null,
            actorUserId: user.userId,
        });
        return { statusCode: 201, body: created };
    }
    throw new errors_1.AppError("unsupported_replay", "Replay action is not supported.", 400);
}
async function replaySyncBatch(params) {
    const parsedResult = replaySchema.safeParse(params.payload);
    if (!parsedResult.success) {
        throw new errors_1.AppError("validation_error", "Invalid replay payload.", 400);
    }
    const parsed = parsedResult.data;
    if (parsed.actions.length === 0) {
        throw new errors_1.AppError("validation_error", "No actions provided.", 400);
    }
    const maxActions = config_1.config.pwa.syncMaxActions;
    if (parsed.actions.length > maxActions) {
        throw new errors_1.AppError("too_many_actions", `Replay batch exceeds ${maxActions} actions.`, 413);
    }
    const batchSize = Buffer.byteLength(JSON.stringify(parsed), "utf8");
    const maxBatchBytes = config_1.config.pwa.syncBatchMaxBytes;
    if (batchSize > maxBatchBytes) {
        throw new errors_1.AppError("payload_too_large", `Replay batch exceeds ${maxBatchBytes} bytes.`, 413);
    }
    const batchId = (0, crypto_1.randomUUID)();
    (0, logger_1.logInfo)("pwa_replay_batch_start", {
        batchId,
        requestId: params.requestId,
        count: parsed.actions.length,
        userId: params.user.userId,
    });
    const results = [];
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
                throw new errors_1.AppError("missing_idempotency_key", "Idempotency-Key is required.", 400);
            }
            if (containsJwt(action.body)) {
                throw new errors_1.AppError("jwt_not_allowed", "JWT tokens are not allowed in replay payloads.", 400);
            }
            assertActionPayloadSize(action.body ?? {});
            const sanitizedBody = sanitizeJson(action.body ?? {});
            const requestHash = hashValue(stableStringify(sanitizedBody));
            const idempotencyKey = action.idempotencyKey.trim();
            const existing = await (0, idempotency_repo_1.findIdempotencyRecord)({
                route: action.path,
                idempotencyKey,
            });
            if (existing) {
                if (existing.request_hash !== requestHash) {
                    throw new errors_1.AppError("idempotency_conflict", "Idempotency key reused with different payload.", 409);
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
            const { statusCode, body } = await executeReplayAction({
                id: action.id,
                method: action.method,
                path: action.path,
                body: sanitizedBody,
                idempotencyKey,
            }, params.user);
            await (0, idempotency_repo_1.createIdempotencyRecord)({
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
            (0, appInsights_1.trackEvent)({
                name: "replay_success",
                properties: {
                    batchId,
                    requestId: params.requestId,
                    actionId: action.id,
                    path: action.path,
                    userId: params.user.userId,
                },
            });
        }
        catch (error) {
            failed = true;
            const appError = error instanceof errors_1.AppError
                ? error
                : new errors_1.AppError("replay_failed", "Replay failed.", 500);
            results.push({
                id: action.id,
                status: "failed",
                statusCode: appError.status,
                error: { code: appError.code, message: appError.message },
            });
            (0, appInsights_1.trackEvent)({
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
    (0, logger_1.logInfo)("pwa_replay_batch_complete", {
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
