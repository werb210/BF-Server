import { z } from "zod";

const boolString = z.enum(["true", "false"]);
const numericString = z.string().regex(/^\d+$/);

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().optional(),
    JWT_SECRET: z.string().min(10),
    OPENAI_API_KEY: z.string().min(1),
    ENABLE_TWILIO: boolString.optional(),
    TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
    TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
    TWILIO_PHONE: z.string().min(1).optional(),

    SENTRY_DSN: z.string().min(1).optional(),
    SLACK_ALERT_WEBHOOK_URL: z.string().min(1).optional(),

    PORT: numericString.optional(),
    PUBLIC_BASE_URL: z.string().min(1).optional(),
    CLIENT_BASE_URL: z.string().min(1).optional(),
    LOG_LEVEL: z.string().min(1).optional(),
    INSTANCE_ID: z.string().min(1).optional(),
    HOSTNAME: z.string().min(1).optional(),
    APPINSIGHTS_CONNECTION_STRING: z.string().min(1).optional(),
    APPLICATIONINSIGHTS_CONNECTION_STRING: z.string().min(1).optional(),
    API_V1_ALLOW_UNFROZEN: boolString.optional(),
    RUN_DB_MIGRATIONS: boolString.optional(),
    SKIP_DB_CONNECTION: boolString.optional(),
    TWILIO_API_KEY: z.string().min(1).optional(),
    TWILIO_API_SECRET: z.string().min(1).optional(),
    TWILIO_VOICE_APP_SID: z.string().min(1).optional(),
    OTP_HASH_SECRET: z.string().min(1).optional(),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_REDIRECT_URI: z.string().min(1).optional(),
    GOOGLE_SHEETS_REFRESH_TOKEN: z.string().min(1).optional(),

    BASE_URL: z.string().min(1).optional(),
    TEST_MODE: boolString.optional(),
    AUTH_DEBUG_OTP_PHONE: z.string().min(1).optional(),
    OTP_HASH_SALT: z.string().min(1).optional(),
    TEST_OTP_CODE: z.string().min(1).optional(),
    AZURE_OPENAI_DEPLOYMENT: z.string().min(1).optional(),
    AZURE_OPENAI_ENDPOINT: z.string().min(1).optional(),
    AZURE_OPENAI_KEY: z.string().min(1).optional(),
    AZURE_STORAGE_CONNECTION_STRING: z.string().min(1).optional(),
    BOOTSTRAP_ADMIN_PHONE: z.string().min(1).optional(),
    CLIENT_URL: z.string().min(1).optional(),
    CODESPACES: z.string().min(1).optional(),
    CODESPACE_NAME: z.string().min(1).optional(),
    GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: z.string().min(1).optional(),
    CORS_ALLOWED_ORIGINS: z.string().min(1).optional(),
    CRM_WEBHOOK_URL: z.string().min(1).optional(),
    DB_HOST: z.string().min(1).optional(),
    DB_SSL: boolString.optional(),
    GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().min(1).optional(),
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().min(1).optional(),
    INTAKE_SMS_NUMBER: z.string().min(1).optional(),
    INTERNAL_API_KEY: z.string().min(1).optional(),
    ENABLE_INT_TEST_ROUTES: boolString.optional(),
    OPENAI_CHAT_MODEL: z.string().min(1).optional(),
    OPENAI_EMBED_MODEL: z.string().min(1).optional(),
    OPENAI_MODEL: z.string().min(1).optional(),
    AI_EMBED_MODEL: z.string().min(1).optional(),
    AI_MODEL: z.string().min(1).optional(),
    AI_SYSTEM_NAME: z.string().min(1).optional(),
    PORTAL_URL: z.string().min(1).optional(),
    PWA_PUSH_ENABLED: boolString.optional(),
    RATE_LIMIT_ENABLED: boolString.optional(),
    TWILIO_FROM: z.string().min(1).optional(),
    TWILIO_FROM_NUMBER: z.string().min(1).optional(),
    TWILIO_CALLER_ID: z.string().min(1).optional(),
    TWILIO_NUMBER: z.string().min(1).optional(),
    TWILIO_PHONE_NUMBER: z.string().min(1).optional(),
    TWILIO_VERIFY_SERVICE_SID: z.string().min(1).optional(),
    ALLOWED_ORIGINS: z.string().min(1).optional(),
    WEBSITE_URL: z.string().min(1).optional(),

    JWT_REFRESH_SECRET: z.string().min(1).optional(),
    JWT_ACCESS_EXPIRES_IN: z.string().min(1).optional(),
    JWT_REFRESH_EXPIRES_MS: numericString.optional(),
    DOCUMENT_MAX_SIZE_BYTES: numericString.optional(),
    DOCUMENT_ALLOWED_MIME_TYPES: z.string().min(1).optional(),
    OCR_TIMEOUT_MS: numericString.optional(),
    LENDER_RETRY_BASE_DELAY_MS: numericString.optional(),
    LENDER_RETRY_MAX_DELAY_MS: numericString.optional(),
    LENDER_RETRY_MAX_COUNT: numericString.optional(),
    FOLLOW_UP_INTERVAL_MS: numericString.optional(),
    FOLLOW_UP_ENABLED: boolString.optional(),
    RATE_LIMIT_WINDOW_MS: numericString.optional(),
    RATE_LIMIT_MAX: numericString.optional(),
    CLIENT_SUBMISSION_OWNER_USER_ID: z.string().min(1).optional(),

    COMMIT_SHA: z.string().min(1).optional(),
    BUILD_TIMESTAMP: z.string().min(1).optional(),
    IDEMPOTENCY_ENABLED: boolString.optional(),
    AUDIT_HISTORY_ENABLED: boolString.optional(),
    JWT_CLOCK_SKEW_SECONDS: numericString.optional(),
    AI_EMBEDDING_MODEL: z.string().min(1).optional(),
    OPENAI_OCR_MODEL: z.string().min(1).optional(),
    OCR_ENABLED: boolString.optional(),
    OCR_PROVIDER: z.string().min(1).optional(),
    OCR_MAX_ATTEMPTS: numericString.optional(),
    OCR_POLL_INTERVAL_MS: numericString.optional(),
    OCR_WORKER_CONCURRENCY: numericString.optional(),
    OCR_LOCK_TIMEOUT_MINUTES: numericString.optional(),
    PWA_SYNC_MAX_ACTIONS: numericString.optional(),
    PWA_SYNC_ACTION_MAX_BYTES: numericString.optional(),
    PWA_SYNC_BATCH_MAX_BYTES: numericString.optional(),
    PWA_PUSH_PAYLOAD_MAX_BYTES: numericString.optional(),
    VAPID_PUBLIC_KEY: z.string().min(1).optional(),
    VAPID_PRIVATE_KEY: z.string().min(1).optional(),
    VAPID_SUBJECT: z.string().min(1).optional(),
    RETRY_POLICY_ENABLED: boolString.optional(),
    REPORTING_JOBS_ENABLED: boolString.optional(),
    REPORTING_DAILY_INTERVAL_MS: numericString.optional(),
    REPORTING_HOURLY_INTERVAL_MS: numericString.optional(),
    VOICE_RESTRICTED_NUMBERS: z.string().optional(),
    MAYA_URL: z.string().url().optional(),
    MAYA_SERVICE_URL: z.string().url().optional(),
    OPS_KILL_SWITCH_REPLAY: boolString.optional(),
    OPS_KILL_SWITCH_EXPORTS: boolString.optional(),
    OPS_KILL_SWITCH_OCR: boolString.optional(),
    OPS_KILL_SWITCH_LENDER_TRANSMISSION: boolString.optional(),

    // BF_SERVER_v789_ENV_INVENTORY - every variable read by live code, optional unless
    // genuinely required at boot. See .env.example for what each one does.
    ABANDONED_EXCLUDE_PHONES: z.string().optional(), // phone number(s), E.164; read in routes/marketing.ts
    ACCOUNTANT_INVITE_SEND_AS: z.string().optional(), // email address(es); read in services/accountantInvite.ts
    AGENT_SERVICE_JWT_SECRET: z.string().optional(), // Secret used to sign/verify these JWTs
    AUTOMATION_QUIET_TZ: z.string().optional(), // IANA time zone; read in modules/automation/automationEngine.ts
    AZURE_DOC_INTEL_ENDPOINT: z.string().optional(), // setting; read in modules/ocr/azureDocIntelProvider.ts
    AZURE_DOC_INTEL_KEY: z.string().optional(), // credential (secret); read in modules/ocr/azureDocIntelProvider.ts
    AZURE_STORAGE_CONTAINER_BF: z.string().optional(), // Azure Blob name/container; read in lib/storage/index.ts
    AZURE_STORAGE_CONTAINER_MARKETING: z.string().optional(), // Azure Blob name/container; read in routes/marketing.ts
    AZURE_STORAGE_CONTAINER_MMS: z.string().optional(), // Azure Blob name/container; read in services/mmsMedia.ts
    BACKEND_SERVICE_TOKEN: z.string().optional(), // credential (secret); read in middleware/serviceToken.ts
    BANKING_AUTO_BATCH: z.string().optional(), // batch size per tick; read in workers/bankingAutoWorker.ts
    BANKING_AUTO_POLL_MS: z.string().optional(), // interval in milliseconds; read in workers/bankingAutoWorker.ts
    BANKING_LLM_MODEL: z.string().optional(), // OpenAI model name; read in modules/ocr/ocr.admin.routes.ts
    BF_SSN_ENCRYPTION_FALLBACK: z.string().optional(), // setting; read in security/ssnCrypto.ts
    BF_START_TIMEOUT_MS: z.string().optional(), // interval in milliseconds; read in routes/publicApplication.ts
    BF_WEBSITE_URL: z.string().optional(), // URL; read in modules/referrals/referralInvite.ts
    BF_WORKERS_ENABLED: z.string().optional(), // true/false switch; read in startup/workersSwitch.ts
    BI_SERVER_URL: z.string().optional(), // URL; read in routes/mayaStaff.ts
    BI_SERVICE_JWT_SECRET: z.string().optional(), // Secret used to sign/verify these JWTs
    BI_WEBSITE_URL: z.string().optional(), // URL; read in modules/referrals/referralInvite.ts
    BOOKING_INTAKE_EXCLUDE: z.string().optional(), // setting; read in services/clientBooking.ts
    BOOKING_STAFF_EMAILS: z.string().optional(), // email address(es); read in services/clientBooking.ts
    BOOTSTRAP_ADMIN2_PHONE: z.string().optional(), // phone number(s), E.164; read in db/seed.ts
    BOREAL_SUPPORT_PHONE: z.string().optional(), // phone number(s), E.164; read in services/accountantInvite.ts
    BROKER_IMPORT_LLM_MODEL: z.string().optional(), // OpenAI model name; read in services/brokerImport/extract.ts
    BUILD_TAG: z.string().optional(), // number; read in app.ts
    CI: z.string().optional(), // Set by CI runners; changes test-only behaviour
    CLARITY_API_TOKEN: z.string().optional(), // credential (secret); read in services/clarityService.ts
    CLARITY_API_TOKEN_CLIENT: z.string().optional(), // credential (secret); read in services/clarityService.ts
    CLARITY_CACHE_MINUTES: z.string().optional(), // number; read in services/clarityService.ts
    CLARITY_PROJECT_ID: z.string().optional(), // identifier; read in services/clarityService.ts
    CLARITY_PROJECT_ID_CLIENT: z.string().optional(), // identifier; read in services/clarityService.ts
    CLIENT_APNS_BUNDLE_ID_BF: z.string().optional(), // identifier; read in services/clientPushService.ts
    CLIENT_APNS_BUNDLE_ID_BI: z.string().optional(), // identifier; read in services/clientPushService.ts
    CLIENT_APNS_ENVIRONMENT: z.string().optional(), // setting; read in services/clientPushService.ts
    CLIENT_APP_MIN_BUILD: z.string().optional(), // number; read in routes/client/index.ts
    CLIENT_APP_URL: z.string().optional(), // URL; read in services/brokerImport/actions.ts
    CLIENT_PORTAL_URL: z.string().optional(), // URL; read in modules/applications/applications.routes.ts
    CLIENT_WEBAUTHN_ORIGINS: z.string().optional(), // setting; read in services/clientPasskeys.ts
    CLIENT_WEBAUTHN_RP_ID: z.string().optional(), // identifier; read in services/clientPasskeys.ts
    CLIENT_WEBAUTHN_RP_NAME: z.string().optional(), // setting; read in services/clientPasskeys.ts
    CREDIT_LLM_MODEL: z.string().optional(), // OpenAI model name; read in services/credit/collateral.ts
    CREDIT_WRITER_MODEL: z.string().optional(), // OpenAI model name; read in services/credit/creditSummaryV2.ts
    DEFAULT_SIGNATURE_USER_ID: z.string().optional(), // identifier; read in services/email/resolveSignature.ts
    ENABLE_CALL_RECORDING: z.string().optional(), // true/false switch; read in routes/conferenceWebhooks.ts
    ENABLE_LIVE_TRANSCRIPTION: z.string().optional(), // true/false switch; read in routes/conferenceWebhooks.ts
    FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(), // setting; read in services/fcmProvider.ts
    GA4_CACHE_MINUTES: z.string().optional(), // number; read in services/ga4Service.ts
    GA4_MP_API_SECRET: z.string().optional(), // credential (secret); read in services/ga4Mp.ts
    GA4_MP_MEASUREMENT_ID: z.string().optional(), // identifier; read in services/ga4Mp.ts
    GA4_PROPERTY_ID: z.string().optional(), // identifier; read in services/ga4Service.ts
    GA4_SA_JSON: z.string().optional(), // setting; read in services/ga4Service.ts
    GOOGLE_ADS_ALLOW_MUTATE: z.string().optional(), // setting; read in services/googleAdsSuggestions.ts
    GOOGLE_ADS_CAMP_WASTE_COST: z.string().optional(), // number; read in services/googleAdsSuggestions.ts
    GOOGLE_ADS_CLIENT_ID: z.string().optional(), // identifier; read in services/customerMatchLists.ts
    GOOGLE_ADS_CLIENT_SECRET: z.string().optional(), // credential (secret); read in services/googleAdsConversions.ts
    GOOGLE_ADS_CM_FUNDED_LIST_ID: z.string().optional(), // identifier; read in services/customerMatchLists.ts
    GOOGLE_ADS_CM_QUALIFIED_LIST_ID: z.string().optional(), // identifier; read in services/googleAudienceSync.ts
    GOOGLE_ADS_COMMISSION_RATE: z.string().optional(), // number; read in services/googleDataManager.ts
    GOOGLE_ADS_CONVERSION_ACTION_ID: z.string().optional(), // identifier; read in services/googleAdsConversions.ts
    GOOGLE_ADS_CURRENCY: z.string().optional(), // setting; read in services/googleAdsConversions.ts
    GOOGLE_ADS_CUSTOMER_ID: z.string().optional(), // identifier; read in services/customerMatchLists.ts
    GOOGLE_ADS_CUSTOMER_MATCH_ENABLED: z.string().optional(), // true/false switch; read in services/googleAdsEnhanced.ts
    GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(), // credential (secret); read in services/googleAdsConversions.ts
    GOOGLE_ADS_KW_WASTE_COST: z.string().optional(), // number; read in services/googleAdsSuggestions.ts
    GOOGLE_ADS_LOGIN_CUSTOMER_ID: z.string().optional(), // identifier; read in services/customerMatchLists.ts
    GOOGLE_ADS_QUALIFIED_CONVERSION_ACTION_ID: z.string().optional(), // identifier; read in services/googleAdsLeadSignals.ts
    GOOGLE_ADS_REFRESH_TOKEN: z.string().optional(), // credential (secret); read in services/customerMatchLists.ts
    GOOGLE_ADS_STRONG_ROAS: z.string().optional(), // number; read in services/googleAdsSuggestions.ts
    GOOGLE_ADS_SUBMIT_CONVERSION_ACTION_ID: z.string().optional(), // identifier; read in services/googleAdsConversions.ts
    GOOGLE_HEALTH_ALERT_EMAILS: z.string().optional(), // email address(es); read in services/adsWeeklyEmail.ts
    GOOGLE_HEALTH_ALERT_PHONES: z.string().optional(), // phone number(s), E.164; read in services/googleHealth.ts
    GOOGLE_PLACES_API_KEY: z.string().optional(), // credential (secret); read in services/credit/research.ts
    LANDING_BASE_URL: z.string().optional(), // URL; read in services/landingPage.service.ts
    LEAD_ALERT_SMS_TO: z.string().optional(), // phone number(s), E.164; read in services/googleHealth.ts
    LENDER_PACKAGE_ATTACH_MAX_BYTES: z.string().optional(), // number; read in services/lenders/packageLink.ts
    LENDER_PACKAGE_BATCH: z.string().optional(), // batch size per tick; read in workers/lenderPackageWorker.ts
    LENDER_PACKAGE_LINK_DAYS: z.string().optional(), // number; read in services/lenders/packageLink.ts
    LENDER_PACKAGE_MAX_UNSIGNED_ATTEMPTS: z.string().optional(), // number; read in workers/lenderPackageWorker.ts
    LENDER_PACKAGE_POLL_MS: z.string().optional(), // interval in milliseconds; read in workers/lenderPackageWorker.ts
    LENDER_PACKAGE_UNSIGNED_RETRY_MS: z.string().optional(), // interval in milliseconds; read in workers/lenderPackageWorker.ts
    LINKEDIN_ADS_ACCOUNT_ID: z.string().optional(), // identifier; read in services/linkedInAdsConversions.ts
    LINKEDIN_ADS_CAMP_WASTE_COST: z.string().optional(), // number; read in services/linkedInAdsSuggestions.ts
    LINKEDIN_ADS_CLIENT_ID: z.string().optional(), // identifier; read in services/linkedInAdsConversions.ts
    LINKEDIN_ADS_CLIENT_SECRET: z.string().optional(), // credential (secret); read in services/linkedInAdsConversions.ts
    LINKEDIN_ADS_CURRENCY: z.string().optional(), // setting; read in services/linkedInAdsConversions.ts
    LINKEDIN_ADS_REFRESH_TOKEN: z.string().optional(), // credential (secret); read in services/linkedInAdsConversions.ts
    LINKEDIN_API_VERSION: z.string().optional(), // setting; read in services/linkedInAdsConversions.ts
    LINKEDIN_CONVERSION_URN: z.string().optional(), // setting; read in services/linkedInAdsConversions.ts
    MAYA_FALLBACK_SMS_NUMBERS: z.string().optional(), // phone number(s), E.164; read in services/notifications/staffSms.ts
    MAYA_RATE_LIMIT_IN_TESTS: z.string().optional(), // number; read in routes/maya.ts
    MSAL_CLIENT_ID: z.string().optional(), // identifier; read in modules/o365/graphClient.ts
    MSAL_CLIENT_SECRET: z.string().optional(), // credential (secret); read in modules/o365/graphClient.ts
    MSAL_TENANT_ID: z.string().optional(), // identifier; read in modules/o365/graphClient.ts
    MS_GRAPH_CLIENT_ID: z.string().optional(), // identifier; read in routes/portal.ts
    MS_GRAPH_CLIENT_SECRET: z.string().optional(), // credential (secret); read in routes/portal.ts
    MS_GRAPH_SEND_AS: z.string().optional(), // email address(es); read in routes/portal.ts
    MS_GRAPH_TENANT_ID: z.string().optional(), // identifier; read in routes/portal.ts
    O365_OAUTH_REDIRECT_URI: z.string().optional(), // URL; read in routes/o365OAuth.ts
    O365_OAUTH_RETURN_URL: z.string().optional(), // URL; read in routes/o365OAuth.ts
    O365_SHARED_INBOX_EMAIL: z.string().optional(), // email address(es); read in routes/email.ts
    PUBLIC_SERVER_URL: z.string().optional(), // URL; read in routes/crm/emails.ts
    RECEPTION_ENABLED: z.string().optional(), // true/false switch; read in routes/webhooks.ts
    RECEPTION_NOVA_VOICE: z.string().optional(), // setting; read in routes/reception.ts
    RESEARCH_LLM_MODEL: z.string().optional(), // OpenAI model name; read in services/credit/research.ts
    REVIEW_LOGIN_CODE: z.string().optional(), // setting; read in services/reviewLogin.ts
    REVIEW_LOGIN_PHONE: z.string().optional(), // phone number(s), E.164; read in services/reviewLogin.ts
    SBA_1919_BLOB: z.string().optional(), // Azure Blob name/container; read in signnow/sba/templates.ts
    SBA_413_BLOB: z.string().optional(), // Azure Blob name/container; read in signnow/sba/templates.ts
    SBA_4506C_BLOB: z.string().optional(), // Azure Blob name/container; read in signnow/sba/sbaFormBuilder.ts
    SBA_912_BLOB: z.string().optional(), // Azure Blob name/container; read in signnow/sba/templates.ts
    SBA_IVES_CITY: z.string().optional(), // setting; read in signnow/sba/sbaFormBuilder.ts
    SBA_IVES_CLIENT_NAME: z.string().optional(), // setting; read in signnow/sba/sbaFormBuilder.ts
    SBA_IVES_CLIENT_PHONE: z.string().optional(), // phone number(s), E.164; read in signnow/sba/sbaFormBuilder.ts
    SBA_IVES_PARTICIPANT_ID: z.string().optional(), // identifier; read in signnow/sba/sbaFormBuilder.ts
    SBA_IVES_PARTICIPANT_NAME: z.string().optional(), // setting; read in signnow/sba/sbaFormBuilder.ts
    SBA_IVES_PHONE: z.string().optional(), // phone number(s), E.164; read in signnow/sba/sbaFormBuilder.ts
    SBA_IVES_SOR_MAILBOX_ID: z.string().optional(), // identifier; read in signnow/sba/sbaFormBuilder.ts
    SBA_IVES_STATE: z.string().optional(), // setting; read in signnow/sba/sbaFormBuilder.ts
    SBA_IVES_STREET: z.string().optional(), // setting; read in signnow/sba/sbaFormBuilder.ts
    SBA_IVES_ZIP: z.string().optional(), // setting; read in signnow/sba/sbaFormBuilder.ts
    SBA_NO_FLATTEN: z.string().optional(), // setting; read in signnow/sba/fillAcroForm.ts
    SENDGRID_API_KEY: z.string().optional(), // credential (secret); read in routes/admin.ts
    SENDGRID_FROM: z.string().optional(), // phone number(s), E.164; read in routes/admin.ts
    SENDGRID_FROM_NAME: z.string().optional(), // phone number(s), E.164; read in services/sendgridService.ts
    SENDGRID_REPLY_TO: z.string().optional(), // phone number(s), E.164; read in services/sendgridService.ts
    SENDGRID_UNSUBSCRIBE_GROUP_ID: z.string().optional(), // identifier; read in services/sendgridService.ts
    SENDGRID_WEBHOOK_PUBLIC_KEY: z.string().optional(), // credential (secret); read in routes/sendgridWebhook.ts
    SERVER_PUBLIC_URL: z.string().optional(), // URL; read in routes/crm/emails.ts
    SERVER_URL: z.string().optional(), // URL; read in config/api.ts
    SIGNNOW_ACCORD_BLANK_BLOB: z.string().optional(), // Azure Blob name/container; read in signnow/accordPdfBuilder.ts
    SIGNNOW_API_BASE_URL: z.string().optional(), // URL; read in signnow/signnowClient.ts
    SIGNNOW_API_KEY: z.string().optional(), // credential (secret); read in routes/admin.ts
    SIGNNOW_BLOB_CONTAINER: z.string().optional(), // Azure Blob name/container; read in signnow/blobStorage.ts
    SIGNNOW_FROM_EMAIL: z.string().optional(), // email address(es); read in services/feeAgreement/mediaFeeAgreement.ts
    SIGNNOW_LINK_EXPIRATION_MINUTES: z.string().optional(), // number; read in signnow/signnowClient.ts
    SIGNNOW_POLL_BATCH: z.string().optional(), // batch size per tick; read in workers/signnowCompletionPoller.ts
    SIGNNOW_POLL_ENABLED: z.string().optional(), // true/false switch; read in workers/signnowCompletionPoller.ts
    SIGNNOW_POLL_MS: z.string().optional(), // interval in milliseconds; read in workers/signnowCompletionPoller.ts
    SIGNNOW_REFERRER_ROLE_NAME: z.string().optional(), // setting; read in modules/referrals/brokerAgreement.service.ts
    SIGNNOW_REFERRER_TEMPLATE_ID: z.string().optional(), // identifier; read in routes/admin.ts
    SIGNNOW_STUB_DELAY_MS: z.string().optional(), // interval in milliseconds; read in signnow/sendApplicationForSignature.ts
    SIGNNOW_STUB_MODE: z.string().optional(), // setting; read in services/submission/orchestrator.ts
    SIGNNOW_WEBHOOK_SECRET: z.string().optional(), // credential (secret); read in routes/signnow.ts
    SIGNNOW_WEBHOOK_URL: z.string().optional(), // URL; read in signnow/ensureWebhookSubscription.ts
    TWILIO_DEFAULT_OUTBOUND_CALLER_ID: z.string().optional(), // identifier; read in telephony/routes/telephonyRoutes.ts
    TWILIO_LOOKUP_LINE_TYPE: z.string().optional(), // setting; read in lib/phoneLineType.ts
    TWILIO_MAIN_LINE_NUMBER: z.string().optional(), // phone number(s), E.164; read in voice/directLines.ts
    TWILIO_RCS_MESSAGING_SERVICE_SID: z.string().optional(), // identifier; read in lib/smsFrom.ts
    TWILIO_SHORTEN_LINKS: z.string().optional(), // setting; read in lib/smsFrom.ts
    TWILIO_SMS_FROM: z.string().optional(), // phone number(s), E.164; read in services/marketingSms.ts
    TWILIO_TEST_TO: z.string().optional(), // phone number(s), E.164; read in routes/_int.ts
    TWILIO_US_SMS_FROM: z.string().optional(), // phone number(s), E.164; read in lib/smsFrom.ts
    VOICEMAIL_BLOB_CONTAINER: z.string().optional(), // Azure Blob name/container; read in modules/voice/voicemailEnrich.service.ts
    VOICEMAIL_NOTIFY_NUMBER: z.string().optional(), // phone number(s), E.164; read in modules/voice/voicemailEnrich.service.ts
    VOICE_INTELLIGENCE_SERVICE_SID: z.string().optional(), // identifier; read in routes/recordingWebhooks.ts
    WATCH_APNS_BUNDLE_ID: z.string().optional(), // identifier; read in watch/initWatchPush.ts
    WATCH_APNS_KEY_ID: z.string().optional(), // identifier; read in services/clientPushService.ts
    WATCH_APNS_PRIVATE_KEY: z.string().optional(), // credential (secret); read in services/clientPushService.ts
    WATCH_APNS_TEAM_ID: z.string().optional(), // identifier; read in services/clientPushService.ts
    WATCH_JWT_SECRET: z.string().optional(), // Secret used to sign/verify these JWTs
    WATCH_PUSH_ENCRYPTION_KEY: z.string().optional(), // credential (secret); read in watch/pushTokenCrypto.ts
    WEBAUTHN_ORIGINS: z.string().optional(), // setting; read in routes/webauthn.ts
    WEBAUTHN_RP_ID: z.string().optional(), // identifier; read in routes/webauthn.ts
    WEBAUTHN_RP_NAME: z.string().optional(), // setting; read in routes/webauthn.ts
    WEBSITE_HOSTNAME: z.string().optional(), // Set by Azure App Service; identifies the host/instance
    WEBSITE_INSTANCE_ID: z.string().optional(), // Set by Azure App Service; identifies the host/instance
    WORKER_STAGGER_MS: z.string().optional(), // interval in milliseconds; read in index.ts
  })
  .passthrough();

export type ParsedEnv = z.infer<typeof EnvSchema>;
