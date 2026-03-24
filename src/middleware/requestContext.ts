import { type NextFunction, type Request, type Response } from "express";
import {
  requestContextMiddleware,
  fetchRequestContext,
  fetchRequestId,
  fetchRequestRoute,
  fetchRequestIdempotencyKeyHash,
  fetchRequestDbProcessIds,
  runWithRequestContext,
} from "../observability/requestContext";

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  requestContextMiddleware(req, res, () => {
    req.requestId = req.id;
    next();
  });
}

export {
  requestContextMiddleware,
  fetchRequestContext,
  fetchRequestId,
  fetchRequestRoute,
  fetchRequestIdempotencyKeyHash,
  fetchRequestDbProcessIds,
  runWithRequestContext,
};
