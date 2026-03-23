import rateLimit from 'express-rate-limit';

export const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 mins
  max: 100, // limit each IP
  standardHeaders: true,
  legacyHeaders: false,
});
