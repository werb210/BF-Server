import { Request, Response } from "express";

export const intHealthHandler = (req: Request, res: Response) => {
  res.json({
    success: true,
    status: "ok",
  });
};
