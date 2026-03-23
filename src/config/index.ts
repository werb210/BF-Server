export type Config = {
  env: string;
  api: {
    baseUrl?: string;
  };
  app: {
    baseUrl?: string;
    testMode?: string;
  };
  auth: {
    debugOtpPhone?: string;
    otpHashSalt?: string;
    testOtpCode?: string;
  };
  azureOpenai: {
    deployment?: string;
    endpoint?: string;
    key?: string;
  };
  azureStorage: {
    connectionString?: string;
  };
  bootstrap: {
    adminPhone?: string;
  };
  client: {
    url?: string;
  };
  codespaces: {
    enabled?: string;
    name?: string;
    portForwardingDomain?: string;
  };
  cors: {
    allowedOrigins?: string;
  };
  crm: {
    webhookUrl?: string;
  };
  db: {
    host: string;
    ssl?: string;
  };
  google: {
    serviceAccountEmail?: string;
    serviceAccountPrivateKey?: string;
  };
  intake: {
    smsNumber?: string;
  };
  internal: {
    apiKey?: string;
    enableTestRoutes?: string;
  };
  jwt: {
    secret: string;
  };
  openai: {
    apiKey?: string;
    chatModel?: string;
    embedModel?: string;
    model?: string;
  };
  ai: {
    embedModel?: string;
    model?: string;
    systemName?: string;
  };
  portal: {
    url?: string;
  };
  pwa: {
    pushEnabled?: string;
  };
  rateLimit: {
    enabled?: string;
  };
  redis: {
    url: string;
  };
  twilio: {
    accountSid?: string;
    apiKey?: string;
    apiSecret?: string;
    authToken?: string;
    from?: string;
    number?: string;
    phone?: string;
    phoneNumber?: string;
    verifyServiceSid?: string;
    voiceAppSid?: string;
  };
  allowedOrigins?: string;
  website: {
    url?: string;
  };
};

const getRequiredEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const config: Config = {
  env: process.env.NODE_ENV ?? "development",
  api: {
    baseUrl: process.env.API_BASE_URL,
  },
  app: {
    baseUrl: process.env.BASE_URL,
    testMode: process.env.TEST_MODE,
  },
  auth: {
    debugOtpPhone: process.env.AUTH_DEBUG_OTP_PHONE,
    otpHashSalt: process.env.OTP_HASH_SALT,
    testOtpCode: process.env.TEST_OTP_CODE,
  },
  azureOpenai: {
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    key: process.env.AZURE_OPENAI_KEY,
  },
  azureStorage: {
    connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
  },
  bootstrap: {
    adminPhone: process.env.BOOTSTRAP_ADMIN_PHONE,
  },
  client: {
    url: process.env.CLIENT_URL,
  },
  codespaces: {
    enabled: process.env.CODESPACES,
    name: process.env.CODESPACE_NAME,
    portForwardingDomain: process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN,
  },
  cors: {
    allowedOrigins: process.env.CORS_ALLOWED_ORIGINS,
  },
  crm: {
    webhookUrl: process.env.CRM_WEBHOOK_URL,
  },
  db: {
    host: getRequiredEnv("DB_HOST"),
    ssl: process.env.DB_SSL,
  },
  google: {
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    serviceAccountPrivateKey: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  },
  intake: {
    smsNumber: process.env.INTAKE_SMS_NUMBER,
  },
  internal: {
    apiKey: process.env.INTERNAL_API_KEY,
    enableTestRoutes: process.env.ENABLE_INT_TEST_ROUTES,
  },
  jwt: {
    secret: getRequiredEnv("JWT_SECRET"),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    chatModel: process.env.OPENAI_CHAT_MODEL,
    embedModel: process.env.OPENAI_EMBED_MODEL,
    model: process.env.OPENAI_MODEL,
  },
  ai: {
    embedModel: process.env.AI_EMBED_MODEL,
    model: process.env.AI_MODEL,
    systemName: process.env.AI_SYSTEM_NAME,
  },
  portal: {
    url: process.env.PORTAL_URL,
  },
  pwa: {
    pushEnabled: process.env.PWA_PUSH_ENABLED,
  },
  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED,
  },
  redis: {
    url: getRequiredEnv("REDIS_URL"),
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    apiKey: process.env.TWILIO_API_KEY,
    apiSecret: process.env.TWILIO_API_SECRET,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_FROM,
    number: process.env.TWILIO_NUMBER,
    phone: process.env.TWILIO_PHONE,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER,
    verifyServiceSid: process.env.TWILIO_VERIFY_SERVICE_SID,
    voiceAppSid: process.env.TWILIO_VOICE_APP_SID,
  },
  allowedOrigins: process.env.ALLOWED_ORIGINS,
  website: {
    url: process.env.WEBSITE_URL,
  },
};
