"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeTool = executeTool;
const db_1 = require("../lib/db");
async function executeTool(callId, name, params, fn) {
    let attempts = 0;
    while (attempts < 3) {
        try {
            const result = await fn();
            await (0, db_1.runQuery)("insert into tool_log(call_id, name) values ($1,$2)", [
                callId,
                name,
            ]);
            return result;
        }
        catch (err) {
            attempts++;
            if (attempts >= 3) {
                await (0, db_1.runQuery)("insert into dead_letter(call_id, name) values ($1,$2)", [
                    callId,
                    name,
                ]);
                throw err;
            }
        }
    }
    throw new Error(`Tool execution failed unexpectedly: ${name}`);
}
