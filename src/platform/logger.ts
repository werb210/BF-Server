import pino from "pino";
import { fetchRequestId } from "../observability/requestContext";

const base = pino({
  level: process.env.LOG_LEVEL || "info",
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
