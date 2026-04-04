"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAI = runAI;
async function runAI(source, message, history, context = {}) {
    if (context?.role && context.role !== "staff" && context.role !== "system") {
        return Promise.reject({
            code: "forbidden",
            status: 403,
        });
    }
    return { text: "ok" };
}
