import jwt from "jsonwebtoken";
import { env } from "../config/env";

export function signToken(payload: Record<string, unknown>) {
  if (!env.JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured");
  }

  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "1h" });
}
