import rateLimit from 'express-rate-limit';

export const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});

export const documentUploadRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
});

export const clientSubmissionRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
});

export const lenderSubmissionRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
});

export function pushSendRateLimit() {
  return (_req: any, _res: any, next: any) => next();
}

export function adminRateLimit() {
  return (_req: any, _res: any, next: any) => next();
}
