type EnvShape = {
  NODE_ENV: string;
  DATABASE_URL: string;

  RATE_LIMIT_WINDOW_MS: number;
  RATE_LIMIT_MAX: number;

  CLIENT_URL: string;
  PORTAL_URL: string;

  JWT_SECRET: string;
  JWT_REFRESH_SECRET: string;

  TEST_MODE: boolean;
};

export const ENV: EnvShape = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: process.env.DATABASE_URL || '',

  RATE_LIMIT_WINDOW_MS: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX || 100),

  CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:3000',
  PORTAL_URL: process.env.PORTAL_URL || 'http://localhost:3001',

  JWT_SECRET: process.env.JWT_SECRET || 'dev-secret',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',

  TEST_MODE: process.env.TEST_MODE === 'true',
};

/* helpers */
export const isProductionEnvironment = () =>
  ENV.NODE_ENV === 'production';

export const getIdempotencyEnabled = () => false;
export const getAuditHistoryEnabled = () => false;

export const getAccessTokenSecret = () => ENV.JWT_SECRET;
export const getAccessTokenExpiresIn = () => '1h';
export const getJwtClockSkewSeconds = () => 0;

export const getAiModel = () => 'gpt-4';
export const getAiEmbeddingModel = () => 'text-embedding-3-small';
