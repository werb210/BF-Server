"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.postAiEscalate = exports.postAiChat = void 0;
const openai_1 = __importDefault(require("openai"));
const crypto_1 = require("crypto");
const db_1 = require("../db");
const safeHandler_1 = require("../middleware/safeHandler");
const retrievalService_1 = require("./retrievalService");
const lenderMatchEngine_1 = require("./lenderMatchEngine");
const config_1 = require("../config");
const events_1 = require("../realtime/events");
const circuitBreaker_1 = require("../utils/circuitBreaker");
const retry_1 = require("../utils/retry");
function detectIntent(message) {
    const lower = message.toLowerCase();
    if (lower.includes("agent") || lower.includes("human") || lower.includes("escalat")) {
        return "escalation";
    }
    if (["revenue", "province", "amount", "prequal", "eligible", "time in business"].some((k) => lower.includes(k))) {
        return "prequal";
    }
    return "faq";
}
function extractPrequalData(message) {
    const revenueMatch = message.match(/revenue[^\d]*(\d[\d,]*)/i);
    const amountMatch = message.match(/(?:amount|need|request)[^\d]*(\d[\d,]*)/i);
    const monthsMatch = message.match(/(\d{1,3})\s*(?:months?|mos?)/i);
    const provinceMatch = message.match(/\b(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\b/i);
    const result = {};
    const revenueValue = revenueMatch?.[1];
    if (revenueValue)
        result.revenue = Number(revenueValue.replace(/,/g, ""));
    const amountValue = amountMatch?.[1];
    if (amountValue)
        result.requestedAmount = Number(amountValue.replace(/,/g, ""));
    const monthsValue = monthsMatch?.[1];
    if (monthsValue)
        result.timeInBusiness = Number(monthsValue);
    const provinceValue = provinceMatch?.[1];
    if (provinceValue)
        result.province = provinceValue.toUpperCase();
    return result;
}
async function createAiResponse(prompt, context) {
    const apiKey = config_1.config.openai.apiKey;
    if (!apiKey) {
        return `I can help with Boreal Marketplace questions. Based on our knowledge base: ${context
            .slice(0, 2)
            .join(" ")}`;
    }
    const client = new openai_1.default({ apiKey });
    const response = await (0, retry_1.retry)(async () => {
        (0, circuitBreaker_1.circuitGuard)();
        try {
            const completion = await client.chat.completions.create({
                model: config_1.config.ai.model,
                messages: [
                    {
                        role: "system",
                        content: "You are Boreal Marketplace AI. Position Boreal as a marketplace, never promise lender approval, and if data is missing say you do not know.",
                    },
                    {
                        role: "user",
                        content: `Question: ${prompt}\n\nContext:\n${context.join("\n---\n")}`,
                    },
                ],
                temperature: 0.2,
            });
            (0, circuitBreaker_1.resetCircuit)();
            return completion;
        }
        catch (error) {
            (0, circuitBreaker_1.recordFailure)();
            throw error;
        }
    });
    return response.choices[0]?.message?.content ?? "I could not generate a response.";
}
exports.postAiChat = (0, safeHandler_1.safeHandler)(async (req, res) => {
    const body = req.body;
    if (!body.message || !body.message.trim()) {
        res.status(400).json({ code: "invalid_request", message: "message is required" });
        return;
    }
    const sessionId = body.sessionId ?? (0, crypto_1.randomUUID)();
    const userType = body.userType ?? "guest";
    await (0, db_1.runQuery)(`insert into chat_sessions (id, user_type, status, escalated_to, created_at, updated_at)
     values ($1, $2, 'active', null, now(), now())
     on conflict (id) do update set updated_at = now()`, [sessionId, userType]);
    await (0, db_1.runQuery)(`insert into chat_messages (id, session_id, role, message, metadata, created_at)
     values ($1, $2, 'user', $3, null, now())`, [(0, crypto_1.randomUUID)(), sessionId, body.message]);
    const intent = detectIntent(body.message);
    const prequal = extractPrequalData(body.message);
    const shouldStorePrequal = prequal.revenue !== undefined ||
        prequal.requestedAmount !== undefined ||
        prequal.timeInBusiness !== undefined ||
        prequal.province !== undefined;
    let lenderMatches;
    if (shouldStorePrequal) {
        await (0, db_1.runQuery)(`insert into ai_prequal_sessions
       (id, session_id, revenue, industry, time_in_business, province, requested_amount, lender_matches, created_at)
       values ($1, $2, $3, null, $4, $5, $6, $7::jsonb, now())`, [
            (0, crypto_1.randomUUID)(),
            sessionId,
            prequal.revenue ?? null,
            prequal.timeInBusiness ?? null,
            prequal.province ?? null,
            prequal.requestedAmount ?? null,
            JSON.stringify([]),
        ]);
    }
    if (intent === "prequal" && prequal.requestedAmount && prequal.revenue) {
        lenderMatches = await (0, lenderMatchEngine_1.matchLenders)({
            requestedAmount: prequal.requestedAmount,
            revenue: prequal.revenue,
            ...(prequal.timeInBusiness !== undefined
                ? { timeInBusiness: prequal.timeInBusiness }
                : {}),
            ...(prequal.province !== undefined ? { province: prequal.province } : {}),
        });
        await (0, db_1.runQuery)(`update ai_prequal_sessions
       set lender_matches = $2::jsonb
       where session_id = $1`, [sessionId, JSON.stringify(lenderMatches)]);
    }
    const knowledge = await (0, retrievalService_1.retrieveTopKnowledgeChunks)(body.message, 5);
    const aiMessage = await createAiResponse(body.message, knowledge.map((chunk) => chunk.content));
    await (0, db_1.runQuery)(`insert into chat_messages (id, session_id, role, message, metadata, created_at)
     values ($1, $2, 'ai', $3, $4::jsonb, now())`, [(0, crypto_1.randomUUID)(), sessionId, aiMessage, JSON.stringify({ intent })]);
    res.status(200).json({
        sessionId,
        message: aiMessage,
        suggestions: [
            "Ask about lender criteria",
            "Check prequalification likelihood",
            "Request a human specialist",
        ],
        lenderMatches,
        escalationAvailable: true,
    });
});
exports.postAiEscalate = (0, safeHandler_1.safeHandler)(async (req, res) => {
    const { sessionId, escalatedTo, messages } = req.body;
    if (!sessionId) {
        res.status(400).json({ code: "invalid_request", message: "sessionId is required" });
        return;
    }
    await (0, db_1.runQuery)(`update chat_sessions
     set status = 'escalated', escalated_to = $2, updated_at = now()
     where id = $1`, [sessionId, escalatedTo ?? null]);
    await (0, db_1.runQuery)(`insert into ai_escalations (id, session_id, messages, status, created_at)
     values ($1, $2, $3::jsonb, 'open', now())`, [(0, crypto_1.randomUUID)(), sessionId, JSON.stringify(messages ?? [])]);
    (0, events_1.emitAiEscalation)({
        sessionId,
        escalatedTo: escalatedTo ?? null,
        triggeredBy: req.user?.userId ?? null,
        timestamp: new Date().toISOString(),
    });
    res.status(200).json({ ok: true });
});
