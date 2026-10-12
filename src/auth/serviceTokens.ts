// BF_SERVER_v789_SERVICE_TOKENS
// One place that signs and verifies service-to-service JWTs.
//
// Outbound: everything BF-Server signs carries iss "bf-server" and an aud.
// Tokens bound for BI-Server use BI_SERVICE_JWT_SECRET when it is set, else
// JWT_SECRET. Every other audience uses JWT_SECRET.
//
// Inbound: a service token from BI-Server verifies with BI_SERVICE_JWT_SECRET
// when that is set (a JWT_SECRET-signed token claiming to be BI-Server is then
// rejected), else JWT_SECRET. A service token from the agent verifies with
// AGENT_SERVICE_JWT_SECRET when set (same rule), else JWT_SECRET. Every
// verifier pins HS256 and rejects a token whose aud is present and is not
// "bf-server"; a token without aud still passes.
import jwt, { type SignOptions } from "jsonwebtoken";

export const BF_SERVER_ISSUER = "bf-server";
export const BF_SERVER_AUDIENCE = "bf-server";

export type ServiceAudience = "bi-server" | "agent" | "bf-server" | (string & {});
export type ServiceSender = "bi-server" | "agent" | "other";

export class ServiceTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceTokenError";
  }
}

function nonEmpty(v: string | undefined): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
}

function jwtSecret(): string | null {
  return nonEmpty(process.env.JWT_SECRET);
}

function signingSecretFor(aud: ServiceAudience): string | null {
  if (aud === "bi-server") return nonEmpty(process.env.BI_SERVICE_JWT_SECRET) ?? jwtSecret();
  return jwtSecret();
}

export type SignServiceTokenOptions = {
  // Identity claim the receiving service checks. Defaults to "bf-server".
  source?: string;
  expiresIn?: SignOptions["expiresIn"];
  claims?: Record<string, unknown>;
  // BF_SERVER_v789_SERVICE_TOKENS - token kind; defaults to "service". The Maya
  // identity header uses "maya_context" (the agent checks it).
  kind?: string;
};

export function signServiceToken(aud: ServiceAudience, opts: SignServiceTokenOptions = {}): string {
  const secret = signingSecretFor(aud);
  if (!secret) throw new ServiceTokenError("service token secret is not configured");
  const payload: Record<string, unknown> = {
    ...(opts.claims ?? {}),
    kind: opts.kind ?? "service",
    source: opts.source ?? "bf-server",
  };
  return jwt.sign(payload, secret, {
    algorithm: "HS256",
    issuer: BF_SERVER_ISSUER,
    audience: aud,
    expiresIn: opts.expiresIn ?? "5m",
  });
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

// Who claims to have signed this token. Read from the unverified payload only to
// pick the key; the signature check that follows is what proves it.
export function serviceSenderOf(claims: Record<string, unknown>): ServiceSender {
  const ids = [str(claims.iss), str(claims.source), str(claims.service), str(claims.id), str(claims.sub)];
  if (ids.some((v) => v === "bi-server" || v === "bi" || v === "bi_server")) return "bi-server";
  if (ids.some((v) => v === "agent" || v === "bf-agent" || v === "agent-service" || v === "maya-service" || v === "maya")) {
    return "agent";
  }
  return "other";
}

function verifyingSecretFor(sender: ServiceSender): string | null {
  if (sender === "bi-server") return nonEmpty(process.env.BI_SERVICE_JWT_SECRET) ?? jwtSecret();
  if (sender === "agent") return nonEmpty(process.env.AGENT_SERVICE_JWT_SECRET) ?? jwtSecret();
  return jwtSecret();
}

export function audienceAllowed(aud: unknown): boolean {
  if (aud === undefined || aud === null) return true;
  if (typeof aud === "string") return aud === BF_SERVER_AUDIENCE;
  if (Array.isArray(aud)) return aud.length > 0 && aud.every((a) => a === BF_SERVER_AUDIENCE);
  return false;
}

// True when the unverified payload says this is a service token. Callers use it
// to route the token to verifyServiceToken instead of the staff/client path.
export function looksLikeServiceToken(token: string): boolean {
  const decoded = jwt.decode(token);
  if (!decoded || typeof decoded !== "object") return false;
  const c = decoded as Record<string, unknown>;
  if (c.kind === "service" || c.principal === "service") return true;
  const id = str(c.id) || str(c.userId) || str(c.sub);
  return id === "agent-service" || id === "maya-service";
}

export type VerifiedServiceToken = {
  sender: ServiceSender;
  claims: Record<string, unknown>;
};

export function verifyServiceToken(token: string): VerifiedServiceToken {
  const unverified = jwt.decode(token);
  if (!unverified || typeof unverified !== "object") throw new ServiceTokenError("malformed token");
  const sender = serviceSenderOf(unverified as Record<string, unknown>);
  const secret = verifyingSecretFor(sender);
  if (!secret) throw new ServiceTokenError("service token secret is not configured");
  let claims: Record<string, unknown>;
  try {
    const verified = jwt.verify(token, secret, { algorithms: ["HS256"] });
    if (!verified || typeof verified !== "object") throw new ServiceTokenError("invalid token");
    claims = verified as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ServiceTokenError) throw err;
    throw new ServiceTokenError("invalid token");
  }
  if (!audienceAllowed(claims.aud)) throw new ServiceTokenError("wrong audience");
  // The verified payload must still name the same sender the key was chosen for.
  if (serviceSenderOf(claims) !== sender) throw new ServiceTokenError("sender mismatch");
  return { sender, claims };
}

export function tryVerifyServiceToken(token: string): VerifiedServiceToken | null {
  try {
    return verifyServiceToken(token);
  } catch {
    return null;
  }
}
