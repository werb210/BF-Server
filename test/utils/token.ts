import jwt from "jsonwebtoken";

interface TokenPayload {
  userId?: string;
  role?: string;
}

export function generateTestToken(payload: TokenPayload = {}): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET must be set for test token generation");
  }
  return jwt.sign({ userId: "test-user", role: "tester", ...payload }, secret, {
    expiresIn: "1h",
  });
}
