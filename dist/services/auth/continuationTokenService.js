import jwt from "jsonwebtoken";
import { config } from "../../config/index.js";
export function verifyClientContinuationToken(token) {
    try {
        const secret = config.jwt.secret ?? "test";
        const decoded = jwt.verify(token, secret);
        if (!decoded || typeof decoded.userId !== "string" || !decoded.userId.trim()) {
            return null;
        }
        return { userId: decoded.userId };
    }
    catch {
        return null;
    }
}
