import { EnvSchema } from "./schema";

const env = process.env as Record<string, string | undefined>;
const parsed = EnvSchema.parse(env);

export const config = Object.freeze({
  env: parsed.NODE_ENV,
  port: parsed.PORT ? Number(parsed.PORT) : 3000,
  logLevel: parsed.LOG_LEVEL,
  api: Object.freeze({
    baseUrl: env.API_BASE_URL,
  }),
  app: Object.freeze({
    baseUrl: env.BASE_URL,
    testMode: env.TEST_MODE,
  }),
  auth: Object.freeze({
    debugOtpPhone: env.AUTH_DEBUG_OTP_PHONE,
    otpHashSalt: env.OTP_HASH_SALT,
    testOtpCode: env.TEST_OTP_CODE,
  }),
  azureOpenai: Object.freeze({
    deployment: env.AZURE_OPENAI_DEPLOYMENT,
    endpoint: env.AZURE_OPENAI_ENDPOINT,
    key: env.AZURE_OPENAI_KEY,
  }),
  azureStorage: Object.freeze({
    connectionString: env.AZURE_STORAGE_CONNECTION_STRING,
  }),
  bootstrap: Object.freeze({
    adminPhone: env.BOOTSTRAP_ADMIN_PHONE,
  }),
  client: Object.freeze({
    url: env.CLIENT_URL,
  }),
  codespaces: Object.freeze({
    enabled: env.CODESPACES,
    name: env.CODESPACE_NAME,
    portForwardingDomain: env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN,
  }),
  cors: Object.freeze({
    allowedOrigins: env.CORS_ALLOWED_ORIGINS,
  }),
  crm: Object.freeze({
    webhookUrl: env.CRM_WEBHOOK_URL,
  }),
  db: Object.freeze({
    url: parsed.DATABASE_URL,
    host: env.DB_HOST,
    ssl: env.DB_SSL,
  }),
  google: Object.freeze({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
    refreshToken: env.GOOGLE_SHEETS_REFRESH_TOKEN,
    serviceAccountEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    serviceAccountPrivateKey: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  }),
  intake: Object.freeze({
    smsNumber: env.INTAKE_SMS_NUMBER,
  }),
  internal: Object.freeze({
    apiKey: env.INTERNAL_API_KEY,
    enableTestRoutes: env.ENABLE_INT_TEST_ROUTES,
  }),
  jwt: Object.freeze({
    secret: parsed.JWT_SECRET,
  }),
  openai: Object.freeze({
    apiKey: parsed.OPENAI_API_KEY,
    chatModel: env.OPENAI_CHAT_MODEL,
    embedModel: env.OPENAI_EMBED_MODEL,
    model: env.OPENAI_MODEL,
  }),
  ai: Object.freeze({
    embedModel: env.AI_EMBED_MODEL,
    model: env.AI_MODEL,
    systemName: env.AI_SYSTEM_NAME,
  }),
  portal: Object.freeze({
    url: env.PORTAL_URL,
  }),
  pwa: Object.freeze({
    pushEnabled: env.PWA_PUSH_ENABLED,
  }),
  rateLimit: Object.freeze({
    enabled: env.RATE_LIMIT_ENABLED,
  }),
  redis: Object.freeze({
    url: parsed.REDIS_URL,
  }),
  twilio: Object.freeze({
    accountSid: parsed.TWILIO_ACCOUNT_SID,
    apiKey: env.TWILIO_API_KEY,
    apiSecret: env.TWILIO_API_SECRET,
    authToken: parsed.TWILIO_AUTH_TOKEN,
    from: env.TWILIO_FROM,
    number: env.TWILIO_NUMBER,
    phone: parsed.TWILIO_PHONE,
    phoneNumber: env.TWILIO_PHONE_NUMBER,
    verifyServiceSid: env.TWILIO_VERIFY_SERVICE_SID,
    voiceAppSid: env.TWILIO_VOICE_APP_SID,
  }),
  allowedOrigins: env.ALLOWED_ORIGINS,
  website: Object.freeze({
    url: env.WEBSITE_URL,
  }),
  urls: Object.freeze({
    apiBase: env.API_BASE_URL,
    publicBase: env.PUBLIC_BASE_URL,
    clientBase: env.CLIENT_BASE_URL,
  }),
  telemetry: Object.freeze({
    instanceId: parsed.INSTANCE_ID ?? parsed.HOSTNAME ?? "unknown",
    appInsightsConnectionString:
      parsed.APPINSIGHTS_CONNECTION_STRING ?? parsed.APPLICATIONINSIGHTS_CONNECTION_STRING,
  }),
  flags: Object.freeze({
    allowUnfrozenApiV1: parsed.API_V1_ALLOW_UNFROZEN === "true",
    runDbMigrations: parsed.RUN_DB_MIGRATIONS === "true",
  }),
  security: Object.freeze({
    otpHashSecret: parsed.OTP_HASH_SECRET,
  }),
});

export type Config = typeof config;
