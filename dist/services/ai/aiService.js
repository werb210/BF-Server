"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateAIResponse = generateAIResponse;
const openai_1 = __importDefault(require("openai"));
const db_1 = require("../../db");
const retrievalService_1 = require("./retrievalService");
const config_1 = require("../../config");
const client = new openai_1.default({
    apiKey: config_1.config.openai.apiKey || "test-openai-key",
});
async function loadSystemRules() {
    const { rows } = await db_1.db.query(`
    select rule_key, rule_value
    from ai_system_rules
    order by rule_key asc
    `);
    if (rows.length === 0) {
        return [
            "- Never mention lender names.",
            "- Always show ranges only.",
            "- Never give underwriting guarantees.",
            "- Never mention startup funding as available.",
            "- Use professional and friendly tone.",
            '- Say: "We have lenders across different capital types, including Institutional lenders, Banking, and Private Capital sources as well as our own funding offerings."',
        ].join("\n");
    }
    return rows.map((row) => `- ${row.rule_key}: ${row.rule_value}`).join("\n");
}
async function generateAIResponse(userMessage) {
    const [context, rules] = await Promise.all([
        (0, retrievalService_1.retrieveRelevantContext)(userMessage),
        loadSystemRules(),
    ]);
    const systemName = config_1.config.ai.systemName ?? "Maya";
    const systemPrompt = `
You are ${systemName}, Boreal Financial's AI assistant.

Rules:
${rules}

Knowledge:
${context}
`;
    const response = await client.chat.completions.create({
        model: config_1.config.openai.model ?? config_1.config.ai.model ?? "gpt-4o-mini",
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
        ],
    });
    return response.choices[0]?.message?.content ?? "";
}
