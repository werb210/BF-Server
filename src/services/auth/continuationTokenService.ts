import jwt from "jsonwebtoken";
import { config } from "../../config/index.js";

type ClientContinuationTokenPayload = {
  userId: string;
};

export function verifyClientContinuationToken(
  token: string
): ClientContinuationTokenPayload | null {
  try {
    // BF_SERVER_JWT_HARDENING_v1 - fell back to the literal string "test" when the secret
    // was unset, which would let anyone forge a client continuation token.
    const secret = config.jwt.secret;
    if (!secret) return null;
    const decoded = jwt.verify(token, secret) as Partial<ClientContinuationTokenPayload>;
    if (!decoded || typeof decoded.userId !== "string" || !decoded.userId.trim()) {
      return null;
    }
    return { userId: decoded.userId };
  } catch {
    return null;
  }
}
