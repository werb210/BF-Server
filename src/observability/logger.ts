import { logger } from "../platform/logger";

export const logInfo = (message: string, meta: Record<string, unknown> = {}) => logger.info(message, meta);
export const logWarn = (message: string, meta: Record<string, unknown> = {}) => logger.warn(message, meta);
export const logError = (message: string, meta: Record<string, unknown> = {}) => logger.error(message, meta);
