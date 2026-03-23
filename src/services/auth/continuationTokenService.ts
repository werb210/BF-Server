import jwt from "jsonwebtoken";
import { config } from "../../config";

type ClientContinuationTokenPayload = {
  userId: string;
};

export function verifyClientContinuationToken(
  token: string
): ClientContinuationTokenPayload | null {
  try {
    const secret = config.jwt.secret ?? "test";
    const decoded = jwt.verify(token, secret) as Partial<ClientContinuationTokenPayload>;
    if (!decoded || typeof decoded.userId !== "string" || !decoded.userId.trim()) {
      return null;
    }
    return { userId: decoded.userId };
  } catch {
    return null;
  }
}
