"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccessTokenVerificationError = exports.AccessTokenSigningError = void 0;
exports.signAccessToken = signAccessToken;
exports.verifyAccessToken = verifyAccessToken;
exports.verifyJwt = verifyJwt;
exports.verifyAccessTokenWithUser = verifyAccessTokenWithUser;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = require("../config");
const roles_1 = require("./roles");
const capabilities_1 = require("./capabilities");
const auth_repo_1 = require("../modules/auth/auth.repo");
const JWT_ISSUER = "boreal-staff-server";
const JWT_AUDIENCE = "boreal-staff-portal";
class AccessTokenSigningError extends Error {
    constructor(message) {
        super(message);
        this.name = "AccessTokenSigningError";
    }
}
exports.AccessTokenSigningError = AccessTokenSigningError;
class AccessTokenVerificationError extends Error {
    constructor(message) {
        super(message);
        this.name = "AccessTokenVerificationError";
    }
}
exports.AccessTokenVerificationError = AccessTokenVerificationError;
function requireJwtSecret() {
    const secret = config_1.config.auth.jwtSecret;
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
    if (!(0, roles_1.isRole)(raw.role)) {
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
            raw.capabilities.some((cap) => typeof cap !== "string" || !(0, capabilities_1.isCapability)(cap)))) {
        throw new AccessTokenVerificationError("Token capabilities claim is invalid");
    }
}
function signAccessToken(payload) {
    const secret = requireJwtSecret();
    const expiresIn = config_1.config.auth.accessExpiresIn;
    const options = {
        algorithm: "HS256",
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
    };
    if (expiresIn !== undefined) {
        options.expiresIn = expiresIn;
    }
    try {
        return jsonwebtoken_1.default.sign(payload, secret, options);
    }
    catch (err) {
        throw new AccessTokenSigningError("Failed to sign access token");
    }
}
function verifyAccessToken(token) {
    const secret = requireJwtSecret();
    let decoded;
    try {
        decoded = jsonwebtoken_1.default.verify(token, secret, {
            algorithms: ["HS256"],
            clockTolerance: config_1.config.auth.jwtClockSkewSeconds,
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
function verifyJwt(token) {
    try {
        const payload = verifyAccessToken(token);
        return { sub: payload.sub };
    }
    catch {
        return { sub: "" };
    }
}
async function verifyAccessTokenWithUser(token) {
    const payload = verifyAccessToken(token);
    const user = await (0, auth_repo_1.findAuthUserById)(payload.sub);
    if (!user) {
        throw new AccessTokenVerificationError("Access token user not found");
    }
    const tokenVersion = user.tokenVersion ?? 0;
    if (payload.tokenVersion !== tokenVersion) {
        throw new AccessTokenVerificationError("Access token has been invalidated");
    }
    return { payload, user };
}
