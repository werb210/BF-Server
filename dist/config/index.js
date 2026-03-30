"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMMIT_SHA = exports.assertEnv = exports.validateServerEnv = exports.ENV = exports.config = exports.env = void 0;
const schema_1 = require("./schema");
const parsed = schema_1.EnvSchema.parse(process.env);
const toNumber = (value, fallback) => {
    if (!value)
        return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
};
const toBool = (value, fallback) => {
    if (value === undefined)
        return fallback;
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};
const csv = (value, fallback) => {
    if (!value)
        return fallback;
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
};
exports.env = {
    PORT: parsed.PORT ? Number(parsed.PORT) : undefined,
};
exports.config = {
    env: parsed.NODE_ENV,
    port: exports.env.PORT ?? 3000,
    isProduction: parsed.NODE_ENV === "production",
    logLevel: parsed.LOG_LEVEL,
    commitSha: parsed.COMMIT_SHA ?? "unknown",
    buildTimestamp: parsed.BUILD_TIMESTAMP ?? new Date(0).toISOString(),
    api: {
        baseUrl: parsed.API_BASE_URL,
    },
    app: {
        baseUrl: parsed.BASE_URL,
        testMode: parsed.TEST_MODE,
    },
    auth: {
        jwtSecret: parsed.JWT_SECRET,
        debugOtpPhone: parsed.AUTH_DEBUG_OTP_PHONE,
        otpHashSalt: parsed.OTP_HASH_SALT,
        testOtpCode: parsed.TEST_OTP_CODE,
        refreshSecret: parsed.JWT_REFRESH_SECRET,
        accessExpiresIn: parsed.JWT_ACCESS_EXPIRES_IN ?? "1h",
        refreshExpiresMs: toNumber(parsed.JWT_REFRESH_EXPIRES_MS, 7 * 24 * 60 * 60 * 1000),
        jwtClockSkewSeconds: toNumber(parsed.JWT_CLOCK_SKEW_SECONDS, 0),
    },
    jwt: {
        secret: parsed.JWT_SECRET,
    },
    openai: {
        apiKey: parsed.OPENAI_API_KEY,
        chatModel: parsed.OPENAI_CHAT_MODEL,
        embedModel: parsed.OPENAI_EMBED_MODEL,
        model: parsed.OPENAI_MODEL ?? "gpt-4o-mini",
        ocrModel: parsed.OPENAI_OCR_MODEL ?? "gpt-4o-mini",
    },
    ai: {
        embedModel: parsed.AI_EMBED_MODEL,
        embeddingModel: parsed.AI_EMBEDDING_MODEL ?? "text-embedding-3-small",
        model: parsed.AI_MODEL ?? "gpt-4o-mini",
        systemName: parsed.AI_SYSTEM_NAME,
    },
    redis: {
        url: parsed.REDIS_URL ?? "",
    },
    db: {
        url: parsed.DATABASE_URL,
        skip: parsed.SKIP_DB_CONNECTION === "true",
        host: parsed.DB_HOST,
        ssl: parsed.DB_SSL,
    },
    twilio: {
        sid: parsed.TWILIO_ACCOUNT_SID ?? "",
        token: parsed.TWILIO_AUTH_TOKEN ?? "",
        phone: parsed.TWILIO_PHONE,
        accountSid: parsed.TWILIO_ACCOUNT_SID ?? "",
        apiKey: parsed.TWILIO_API_KEY,
        apiSecret: parsed.TWILIO_API_SECRET,
        authToken: parsed.TWILIO_AUTH_TOKEN ?? "",
        from: parsed.TWILIO_FROM,
        number: parsed.TWILIO_NUMBER,
        phoneNumber: parsed.TWILIO_PHONE_NUMBER,
        verifyServiceSid: parsed.TWILIO_VERIFY_SERVICE_SID,
        voiceAppSid: parsed.TWILIO_VOICE_APP_SID,
    },
    google: {
        clientId: parsed.GOOGLE_CLIENT_ID,
        clientSecret: parsed.GOOGLE_CLIENT_SECRET,
        redirectUri: parsed.GOOGLE_REDIRECT_URI,
        refreshToken: parsed.GOOGLE_SHEETS_REFRESH_TOKEN,
        serviceAccountEmail: parsed.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        serviceAccountPrivateKey: parsed.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    },
    azureOpenai: {
        deployment: parsed.AZURE_OPENAI_DEPLOYMENT,
        endpoint: parsed.AZURE_OPENAI_ENDPOINT,
        key: parsed.AZURE_OPENAI_KEY,
    },
    azureStorage: {
        connectionString: parsed.AZURE_STORAGE_CONNECTION_STRING,
    },
    client: {
        url: parsed.CLIENT_URL,
        submissionOwnerUserId: parsed.CLIENT_SUBMISSION_OWNER_USER_ID ?? null,
    },
    portal: {
        url: parsed.PORTAL_URL,
    },
    website: {
        url: parsed.WEBSITE_URL,
    },
    cors: {
        allowedOrigins: parsed.CORS_ALLOWED_ORIGINS,
    },
    allowedOrigins: parsed.ALLOWED_ORIGINS,
    intake: {
        smsNumber: parsed.INTAKE_SMS_NUMBER,
    },
    internal: {
        apiKey: parsed.INTERNAL_API_KEY,
        enableTestRoutes: parsed.ENABLE_INT_TEST_ROUTES,
    },
    telemetry: {
        instanceId: parsed.INSTANCE_ID ?? parsed.HOSTNAME ?? "unknown",
        appInsightsConnectionString: parsed.APPINSIGHTS_CONNECTION_STRING ?? parsed.APPLICATIONINSIGHTS_CONNECTION_STRING,
    },
    sentry: {
        dsn: parsed.SENTRY_DSN,
    },
    alerting: {
        slackWebhookUrl: parsed.SLACK_ALERT_WEBHOOK_URL,
    },
    flags: {
        allowUnfrozenApiV1: parsed.API_V1_ALLOW_UNFROZEN === "true",
        runDbMigrations: parsed.RUN_DB_MIGRATIONS === "true",
        skipDbConnection: parsed.SKIP_DB_CONNECTION === "true",
        idempotencyEnabled: toBool(parsed.IDEMPOTENCY_ENABLED, false),
        auditHistoryEnabled: toBool(parsed.AUDIT_HISTORY_ENABLED, false),
        retryPolicyEnabled: toBool(parsed.RETRY_POLICY_ENABLED, true),
        reportingJobsEnabled: toBool(parsed.REPORTING_JOBS_ENABLED, true),
        reportingDailyIntervalMs: toNumber(parsed.REPORTING_DAILY_INTERVAL_MS, 24 * 60 * 60 * 1000),
        reportingHourlyIntervalMs: toNumber(parsed.REPORTING_HOURLY_INTERVAL_MS, 60 * 60 * 1000),
        opsKillSwitchReplay: toBool(parsed.OPS_KILL_SWITCH_REPLAY, false),
        opsKillSwitchExports: toBool(parsed.OPS_KILL_SWITCH_EXPORTS, false),
        opsKillSwitchOcr: toBool(parsed.OPS_KILL_SWITCH_OCR, false),
        opsKillSwitchLenderTransmission: toBool(parsed.OPS_KILL_SWITCH_LENDER_TRANSMISSION, false),
    },
    security: {
        otpHashSecret: parsed.OTP_HASH_SECRET,
        vapidPublicKey: parsed.VAPID_PUBLIC_KEY ?? "",
        vapidPrivateKey: parsed.VAPID_PRIVATE_KEY ?? "",
        vapidSubject: parsed.VAPID_SUBJECT,
        voiceRestrictedNumbers: csv(parsed.VOICE_RESTRICTED_NUMBERS, []),
    },
    rateLimit: {
        enabled: parsed.RATE_LIMIT_ENABLED,
        windowMs: toNumber(parsed.RATE_LIMIT_WINDOW_MS, 60_000),
        max: toNumber(parsed.RATE_LIMIT_MAX, 100),
    },
    lender: {
        retry: {
            baseDelayMs: toNumber(parsed.LENDER_RETRY_BASE_DELAY_MS, 500),
            maxDelayMs: toNumber(parsed.LENDER_RETRY_MAX_DELAY_MS, 5_000),
            maxCount: toNumber(parsed.LENDER_RETRY_MAX_COUNT, 3),
        },
    },
    followUp: {
        intervalMs: toNumber(parsed.FOLLOW_UP_INTERVAL_MS, 60_000),
        enabled: toBool(parsed.FOLLOW_UP_ENABLED, true),
    },
    documents: {
        maxSizeBytes: toNumber(parsed.DOCUMENT_MAX_SIZE_BYTES, 10 * 1024 * 1024),
        allowedMimeTypes: csv(parsed.DOCUMENT_ALLOWED_MIME_TYPES, ["application/pdf", "image/jpeg", "image/png"]),
    },
    pwa: {
        pushEnabled: parsed.PWA_PUSH_ENABLED,
        syncMaxActions: toNumber(parsed.PWA_SYNC_MAX_ACTIONS, 100),
        syncActionMaxBytes: toNumber(parsed.PWA_SYNC_ACTION_MAX_BYTES, 16_384),
        syncBatchMaxBytes: toNumber(parsed.PWA_SYNC_BATCH_MAX_BYTES, 262_144),
        pushPayloadMaxBytes: toNumber(parsed.PWA_PUSH_PAYLOAD_MAX_BYTES, 4096),
    },
    ocr: {
        enabled: toBool(parsed.OCR_ENABLED, true),
        provider: parsed.OCR_PROVIDER ?? "openai",
        timeoutMs: toNumber(parsed.OCR_TIMEOUT_MS, 30_000),
        maxAttempts: toNumber(parsed.OCR_MAX_ATTEMPTS, 3),
        pollIntervalMs: toNumber(parsed.OCR_POLL_INTERVAL_MS, 5_000),
        workerConcurrency: toNumber(parsed.OCR_WORKER_CONCURRENCY, 2),
        lockTimeoutMinutes: toNumber(parsed.OCR_LOCK_TIMEOUT_MINUTES, 30),
    },
    features: {
        ocrEnabled: toBool(parsed.OCR_ENABLED, true),
    },
    bootstrap: {
        adminPhone: parsed.BOOTSTRAP_ADMIN_PHONE,
    },
    codespaces: {
        enabled: parsed.CODESPACES,
        name: parsed.CODESPACE_NAME,
        portForwardingDomain: parsed.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN,
    },
    crm: {
        webhookUrl: parsed.CRM_WEBHOOK_URL,
    },
    urls: {
        apiBase: parsed.API_BASE_URL,
        publicBase: parsed.PUBLIC_BASE_URL,
        clientBase: parsed.CLIENT_BASE_URL,
    },
};
exports.ENV = process.env;
const validateServerEnv = () => {
    if (!exports.config.db.url)
        throw new Error("DATABASE_URL missing");
};
exports.validateServerEnv = validateServerEnv;
exports.assertEnv = exports.validateServerEnv;
exports.COMMIT_SHA = exports.config.commitSha;
