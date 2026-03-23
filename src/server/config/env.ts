
export const ENV = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: process.env.DATABASE_URL || '',
};

/* === ENV HELPERS (COMPAT LAYER) === */

export const isProductionEnvironment = () =>
  ENV.NODE_ENV === 'production';

export const getIdempotencyEnabled = () => false;

export const getAuditHistoryEnabled = () => false;

/* === AUTH === */

export const getAccessTokenSecret = () =>
  process.env.ACCESS_TOKEN_SECRET || 'dev-secret';

export const getAccessTokenExpiresIn = () =>
  process.env.ACCESS_TOKEN_EXPIRES_IN || '1h';

export const getJwtClockSkewSeconds = () => 0;

/* === AI === */

export const getAiModel = () =>
  process.env.AI_MODEL || 'gpt-4';

export const getAiEmbeddingModel = () =>
  process.env.AI_EMBEDDING_MODEL || 'text-embedding-3-small';

