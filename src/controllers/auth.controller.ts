import type { Request, Response } from "express";
import { signToken } from "../services/auth.service";

export async function login(req: Request, res: Response) {
  const { email } = req.body;
  const token = signToken({ email });
  return res.status(200).json({ token });
}
