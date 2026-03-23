import pino from "pino";
import { getRequestId } from "../observability/requestContext";

const base = pino({
  level: process.env.LOG_LEVEL || "info",
});

export const logger = {
  info: (msg: string, extra: Record<string, unknown> = {}) => {
    base.info({ ...extra, requestId: getRequestId() }, msg);
  },
  warn: (msg: string, extra: Record<string, unknown> = {}) => {
    base.warn({ ...extra, requestId: getRequestId() }, msg);
  },
  error: (msg: string, extra: Record<string, unknown> = {}) => {
    base.error({ ...extra, requestId: getRequestId() }, msg);
  },
};
