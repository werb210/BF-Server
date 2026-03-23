import pino from "pino";
import { fetchRequestId } from "../observability/requestContext";
import { config } from "../config";

const base = pino({
  level: config.logLevel ?? "info",
});

export const logger = {
  info: (msg: string, extra: Record<string, unknown> = {}) => {
    base.info({ ...extra, requestId: fetchRequestId() }, msg);
  },
  warn: (msg: string, extra: Record<string, unknown> = {}) => {
    base.warn({ ...extra, requestId: fetchRequestId() }, msg);
  },
  error: (msg: string, extra: Record<string, unknown> = {}) => {
    base.error({ ...extra, requestId: fetchRequestId() }, msg);
  },
};
