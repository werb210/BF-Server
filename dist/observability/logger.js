import { logger } from "../platform/logger.js";
export const logInfo = (message, meta = {}) => logger.info(message, meta);
export const logWarn = (message, meta = {}) => logger.warn(message, meta);
export const logError = (message, meta = {}) => logger.error(message, meta);
