import type { NextFunction, Request, Response } from "express";

export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

export const routeWrap = wrap;
