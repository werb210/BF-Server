"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tagStartupInterest = exports.escalate = exports.createContinuation = exports.closeSession = exports.chat = exports.aiHandler = void 0;
const aiHandler = async (_req, res) => {
    res["json"]({ success: true, message: "AI alive" });
};
exports.aiHandler = aiHandler;
exports.chat = exports.aiHandler;
exports.closeSession = exports.aiHandler;
exports.createContinuation = exports.aiHandler;
exports.escalate = exports.aiHandler;
// alias for older routes
exports.tagStartupInterest = exports.aiHandler;
