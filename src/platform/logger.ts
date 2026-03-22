import pino from "pino";
import { getRequestContext } from "../middleware/requestContext";

const base = pino({
  level: process.env.LOG_LEVEL || "info",
});

export const logger = {
  info: (msg: string, extra: any = {}) => {
    const ctx = getRequestContext();
    base.info({ ...extra, requestId: ctx?.requestId }, msg);
  },
  error: (msg: string, extra: any = {}) => {
    const ctx = getRequestContext();
    base.error({ ...extra, requestId: ctx?.requestId }, msg);
  },
};
