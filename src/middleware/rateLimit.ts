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
