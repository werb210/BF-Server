import { type NextFunction, type Request, type Response } from "express";

export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown
) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req: any, res: any, next: any)).catch(next);
  };
};
