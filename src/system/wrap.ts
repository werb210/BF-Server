import { Request, Response, NextFunction } from "express";

export function wrap(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any> | any
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await fn(req, res, next);

      if (!res.headersSent && result !== undefined) {
        res.json(result);
      }
    } catch (err) {
      next(err);
    }
  };
}
