export const logger = {
  info: console.log,
  error: console.error,
  warn: console.warn,
  debug: console.debug,
};

export const logInfo = (...args: unknown[]) => logger.info(...args);
export const logError = (...args: unknown[]) => logger.error(...args);
export const logWarn = (...args: unknown[]) => logger.warn(...args);
export const logDebug = (...args: unknown[]) => logger.debug(...args);
