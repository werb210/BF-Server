import type { RequestHandler } from "express";
import { requestId } from "./requestId.js";
import { productionLogger, requireHttps, securityHeaders } from "./security.js";

export const coreMiddleware: RequestHandler[] = [
  requestId,
  securityHeaders,
  productionLogger,
  requireHttps,
];
