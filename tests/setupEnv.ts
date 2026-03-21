// tests/setupEnv.ts

process.env.NODE_ENV = 'test';

process.env.JWT_SECRET = 'test_jwt_secret';
process.env.JWT_REFRESH_SECRET = 'test_jwt_refresh_secret';

process.env.DATABASE_URL = 'mock';
process.env.REDIS_URL = 'mock';

process.env.CLIENT_URL = 'http://localhost:3000';
process.env.PORTAL_URL = 'http://localhost:3001';

process.env.TEST_MODE = 'true';
