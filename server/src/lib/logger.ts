type LogLevel = 'info' | 'error' | 'warn' | 'debug';

function log(level: LogLevel, message: string, meta?: unknown) {
  const entry = meta === undefined
    ? {
        level,
        message,
        timestamp: new Date().toISOString()
      }
    : {
        level,
        message,
        meta,
        timestamp: new Date().toISOString()
      };

  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

export const logger = {
  info: (msg: string, meta?: unknown) => log('info', msg, meta),
  error: (msg: string, meta?: unknown) => log('error', msg, meta),
  warn: (msg: string, meta?: unknown) => log('warn', msg, meta),
  debug: (msg: string, meta?: unknown) => log('debug', msg, meta),
};
