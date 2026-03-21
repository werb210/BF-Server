import { Request, Response } from "express"

export function intHealthHandler(_req: Request, res: Response) {
  return res.json({
    success: true,
    status: "ok",
  })
}
