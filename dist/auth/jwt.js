import jwt from "jsonwebtoken";
import { config } from "../config/index.js";
import { isRole } from "./roles.js";
import { isCapability } from "./capabilities.js";
import { findAuthUserById } from "../modules/auth/auth.repo.js";
const JWT_ISSUER = "boreal-staff-server";
const JWT_AUDIENCE = "boreal-staff-portal";
export class AccessTokenSigningError extends Error {
    constructor(message) {
        super(message);
        this.name = "AccessTokenSigningError";
    }
}
export class AccessTokenVerificationError extends Error {
    constructor(message) {
        super(message);
        this.name = "AccessTokenVerificationError";
    }
}
function requireJwtSecret() {
    const secret = config.auth.jwtSecret;
    if (!secret || typeof secret !== "string") {
        throw new AccessTokenSigningError("JWT secret is missing or invalid");
    }
    return secret;
}
function validatePayload(payload) {
    if (!payload || typeof payload !== "object") {
        throw new AccessTokenVerificationError("Token payload is not an object");
    }
    const raw = payload;
    if (typeof raw.sub !== "string" || raw.sub.length === 0) {
        throw new AccessTokenVerificationError("Token subject (sub) is invalid");
    }
    if (!isRole(raw.role)) {
        throw new AccessTokenVerificationError("Token role is invalid");
    }
    if (typeof raw.tokenVersion !== "number" ||
        !Number.isInteger(raw.tokenVersion)) {
        throw new AccessTokenVerificationError("Token version is invalid");
    }
    if (raw.phone !== undefined &&
        raw.phone !== null &&
        typeof raw.phone !== "string") {
        throw new AccessTokenVerificationError("Token phone claim is invalid");
    }
    if (raw.silo !== undefined &&
        (typeof raw.silo !== "string" || raw.silo.trim().length === 0)) {
        throw new AccessTokenVerificationError("Token silo claim is invalid");
    }
    if (raw.capabilities !== undefined &&
        (!Array.isArray(raw.capabilities) ||
            raw.capabilities.some((cap) => typeof cap !== "string" || !isCapability(cap)))) {
        throw new AccessTokenVerificationError("Token capabilities claim is invalid");
    }
}
export function signAccessToken(payload) {
    const secret = requireJwtSecret();
    const expiresIn = config.auth.accessExpiresIn;
    const options = {
        algorithm: "HS256",
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
    };
    if (expiresIn !== undefined) {
        options.expiresIn = expiresIn;
    }
    try {
        return jwt.sign(payload, secret, options);
    }
    catch (err) {
        throw new AccessTokenSigningError("Failed to sign access token");
    }
}
export function verifyAccessToken(token) {
    const secret = requireJwtSecret();
    let decoded;
    try {
        decoded = jwt.verify(token, secret, {
            algorithms: ["HS256"],
            clockTolerance: config.auth.jwtClockSkewSeconds,
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE,
        });
    }
    catch {
        throw new AccessTokenVerificationError("Access token verification failed");
    }
    if (typeof decoded !== "object" || decoded === null) {
        throw new AccessTokenVerificationError("Decoded token is not an object");
    }
    validatePayload(decoded);
    const payload = {
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
export function verifyJwt(token) {
    try {
        const secret = process.env.JWT_SECRET;
        if (!secret)
            throw new Error("INVALID_TOKEN");
        return jwt.verify(token, secret);
    }
    catch {
        throw new Error("INVALID_TOKEN");
    }
}
export function signJwt(payload) {
    const secret = process.env.JWT_SECRET;
    if (!secret)
        throw new Error("INVALID_TOKEN");
    return jwt.sign(payload, secret, {
        expiresIn: "1h",
    });
}
export async function verifyAccessTokenWithUser(token) {
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
