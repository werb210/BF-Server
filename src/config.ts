import { ENV } from './config/env';

export function getTestMode(): boolean {
  return ENV.TEST_MODE === 'true';
}

export function getPortalUrl(): string {
  return ENV.PORTAL_URL || '';
}

export function getClientUrl(): string {
  return ENV.CLIENT_URL || '';
}

export function getJwtSecret(): string {
  return ENV.JWT_SECRET || '';
}

export function getJwtRefreshSecret(): string {
  return ENV.JWT_REFRESH_SECRET || '';
}
