// tests/setupEnv.ts

process.env.NODE_ENV = 'test';
process.env.TEST_MODE = 'true';

process.env.JWT_SECRET = 'test_jwt_secret';
process.env.JWT_REFRESH_SECRET = 'test_jwt_refresh_secret';
process.env.DATABASE_URL = 'mock';

// Keep REDIS_URL empty in tests so session store does not attempt network connections.
process.env.REDIS_URL = '';

process.env.CLIENT_URL = 'https://client.boreal.financial';
process.env.PORTAL_URL = 'https://staff.boreal.financial';
process.env.SERVER_URL = 'https://server.boreal.financial';
