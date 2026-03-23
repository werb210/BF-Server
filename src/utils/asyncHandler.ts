import { Request, Response, NextFunction } from "express";

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any> | any
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req: any, res: any, next: any)).catch(next);
  };
}
