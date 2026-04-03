import jwt from "jsonwebtoken";

interface TokenPayload {
  userId?: string;
  role?: string;
}

export function generateTestToken(payload: TokenPayload = {}): string {
  const secret = process.env.JWT_SECRET ?? "test-secret";
  return jwt.sign({ userId: "test-user", role: "tester", ...payload }, secret, {
    expiresIn: "1h",
  });
}
