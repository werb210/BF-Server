import jwt, { type SignOptions, type JwtPayload } from "jsonwebtoken";
import {
  getAccessTokenExpiresIn,
  getAccessTokenSecret,
  getJwtClockSkewSeconds,
  config,
  runtimeEnv
} from "../server/config/config";
import { type Role, isRole } from "./roles";
import { type Capability, isCapability } from "./capabilities";
import { findAuthUserById, type AuthUser } from "../modules/auth/auth.repo";

export type AccessTokenPayload = {
  sub: string;
  role: Role;
  tokenVersion: number;
  phone?: string | null;
  silo?: string;
  capabilities?: Capability[];
};

const JWT_ISSUER = "boreal-staff-server";
const JWT_AUDIENCE = "boreal-staff-portal";

export class AccessTokenSigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessTokenSigningError";
  }
}

export class AccessTokenVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessTokenVerificationError";
  }
}

function requireJwtSecret(): string {
  const secret = config.auth.jwtSecret;
  if (!secret || typeof secret !== "string") {
    throw new AccessTokenSigningError("JWT secret is missing or invalid");
  }
  return secret;
}

function validatePayload(payload: unknown): asserts payload is AccessTokenPayload {
  if (!payload || typeof payload !== "object") {
    throw new AccessTokenVerificationError("Token payload is not an object");
  }

  const raw = payload as Partial<AccessTokenPayload> & { capabilities?: unknown };

  if (typeof raw.sub !== "string" || raw.sub.length === 0) {
    throw new AccessTokenVerificationError("Token subject (sub) is invalid");
  }

  if (!isRole(raw.role)) {
    throw new AccessTokenVerificationError("Token role is invalid");
  }

  if (
    typeof raw.tokenVersion !== "number" ||
    !Number.isInteger(raw.tokenVersion)
  ) {
    throw new AccessTokenVerificationError("Token version is invalid");
  }

  if (
    raw.phone !== undefined &&
    raw.phone !== null &&
    typeof raw.phone !== "string"
  ) {
    throw new AccessTokenVerificationError("Token phone claim is invalid");
  }

  if (
    raw.silo !== undefined &&
    (typeof raw.silo !== "string" || raw.silo.trim().length === 0)
  ) {
    throw new AccessTokenVerificationError("Token silo claim is invalid");
  }

  if (
    raw.capabilities !== undefined &&
    (!Array.isArray(raw.capabilities) ||
      raw.capabilities.some((cap) => typeof cap !== "string" || !isCapability(cap)))
  ) {
    throw new AccessTokenVerificationError(
      "Token capabilities claim is invalid"
    );
  }
}

export function signAccessToken(payload: AccessTokenPayload): string {
  const secret = requireJwtSecret();
  const expiresIn = config.auth.accessExpiresIn as SignOptions["expiresIn"];
  const options: SignOptions = {
    algorithm: "HS256",
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  };
  if (expiresIn !== undefined) {
    options.expiresIn = expiresIn;
  }

  try {
    return jwt.sign(payload, secret, options);
  } catch (err) {
    throw new AccessTokenSigningError("Failed to sign access token");
  }
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const secret = requireJwtSecret();

  let decoded: JwtPayload | string;

  try {
    decoded = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      clockTolerance: runtimeEnv.jwtClockSkewSeconds,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  } catch {
    throw new AccessTokenVerificationError("Access token verification failed");
  }

  if (typeof decoded !== "object" || decoded === null) {
    throw new AccessTokenVerificationError("Decoded token is not an object");
  }

  validatePayload(decoded);

  const payload: AccessTokenPayload = {
    sub: decoded.sub,
    role: decoded.role,
    tokenVersion: decoded.tokenVersion,
    phone: decoded.phone ?? null,
  };
  if (typeof decoded.silo === "string") {
    payload.silo = decoded.silo;
  }

  return payload;
}

export function verifyJwt(token: string): { sub: string } {
  try {
    const payload = verifyAccessToken(token);
    return { sub: payload.sub };
  } catch {
    return { sub: "" };
  }
}

export async function verifyAccessTokenWithUser(token: string): Promise<{
  payload: AccessTokenPayload;
  user: AuthUser;
}> {
  const payload = verifyAccessToken(token);
  const user = await findAuthUserById(payload.sub);
  if (!user) {
    throw new AccessTokenVerificationError("Access token user not found");
  }
  const tokenVersion = user.tokenVersion ?? 0;
  if (payload.tokenVersion !== tokenVersion) {
    throw new AccessTokenVerificationError("Access token has been invalidated");
  }
  return { payload, user };
}
