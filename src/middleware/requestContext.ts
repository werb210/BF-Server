import { type NextFunction, type Request, type Response } from "express";
import { v4 as uuid } from "uuid";
import {
  requestContextMiddleware,
  fetchRequestContext,
  fetchRequestId,
  fetchRequestRoute,
  fetchRequestIdempotencyKeyHash,
  fetchRequestDbProcessIds,
  runWithRequestContext,
} from "../observability/requestContext.js";

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const headerRid = req.headers["x-request-id"];
  const rid =
    typeof headerRid === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(headerRid)
      ? headerRid
      : uuid();

  req.id = rid;
  req.rid = rid;
  req.requestId = rid;
  req.headers["x-request-id"] = rid;
  res.setHeader("x-request-id", rid);

  requestContextMiddleware(req, res, next);
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
