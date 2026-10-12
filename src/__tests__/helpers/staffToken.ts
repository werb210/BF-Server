// BF_SERVER_v789_SG5 - a staff JWT the test setup's permissive staff-user loader accepts.
import jwt from "jsonwebtoken";

export const STAFF_USER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

export function staffToken(role: "Admin" | "Staff" | string = "Admin", extra: Record<string, unknown> = {}): string {
  return jwt.sign({ sub: STAFF_USER_ID, role, tokenVersion: 0, tv: 0, ...extra }, String(process.env.JWT_SECRET), {
    algorithm: "HS256",
    expiresIn: "1h",
  });
}

export function bearer(role: "Admin" | "Staff" | string = "Admin", extra: Record<string, unknown> = {}): string {
  return `Bearer ${staffToken(role, extra)}`;
}
