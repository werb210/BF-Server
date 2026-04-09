import { rateLimit } from "express-rate-limit";
export const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 200,
    standardHeaders: "draft-8",
    legacyHeaders: false,
});
// Backward-compatible aliases for existing imports.
export const globalRateLimit = globalLimiter;
export const apiRateLimit = globalLimiter;
export const documentUploadRateLimit = globalLimiter;
export const clientSubmissionRateLimit = globalLimiter;
export const lenderSubmissionRateLimit = globalLimiter;
export function pushSendRateLimit() {
    return (_req, _res, next) => next();
}
export function adminRateLimit() {
    return (_req, _res, next) => next();
}
export const voiceRateLimit = () => globalLimiter;
export const portalRateLimit = () => globalLimiter;
export const clientReadRateLimit = () => globalLimiter;
export const clientDocumentsRateLimit = () => globalLimiter;
export const otpLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false,
});
